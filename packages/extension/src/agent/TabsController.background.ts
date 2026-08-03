/**
 * background logics for TabsController
 *
 * Keep this stateless: pure request/response handlers only, no in-memory
 * state, no ports, no event pushing. MV3 SW should be killed and restarted at
 * any time (idle timeout, extension update) without special handling.
 */
import type { TabAction } from './TabsController'

const PREFIX = '[TabsController.background]'

const debug = console.debug.bind(console, `\x1b[90m${PREFIX}\x1b[0m`)

/**
 * KNOVA telemetry. The service worker's console is not readable from outside Chrome, which is why
 * the hub/window bugs took four blind rounds to pin down. The local worker listens on 38403 and
 * appends whatever we POST to /tmp/knova-ext.log, so decisions taken in here become EVIDENCE.
 * Fire-and-forget: never awaited, never throws, and a missing sink is silently fine.
 */
export function knovaLog(event: string, data: Record<string, unknown> = {}): void {
	try {
		void fetch('http://127.0.0.1:38403/log', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ event, ...data }),
		}).catch(() => {})
	} catch {
		/* sink down — telemetry must never affect behaviour */
	}
}

/**
 * Resolve active tab.
 *
 * - `tabs.query({ active: true })` does not work in multi-window scenarios.
 * - Extension pages (side panel, hub tab) can resolve their own windowId.
 *   We just find the active tab within that window.
 * - Content scripts (PAGE_AGENT_EXT) can't self-report a windowId.
 *   Chrome populates `sender.tab` for every content-script message,
 *   which is the tab hosting the script.
 */
async function resolveActiveTab(
	payload: { windowId?: number } | undefined,
	sender: chrome.runtime.MessageSender
): Promise<chrome.tabs.Tab> {
	const windowId = payload?.windowId

	if (windowId != null) {
		debug('get_active_tab: resolving via caller-reported windowId', windowId)
		const [tab] = await chrome.tabs.query({ active: true, windowId })
		if (!tab) throw new Error(`No active tab found in window ${windowId}.`)
		return tab
	}

	if (sender.tab) {
		debug('get_active_tab: resolving via sender.tab (content script)', sender.tab.id)
		return sender.tab
	}

	throw new Error(
		'Cannot resolve active tab: caller reported no windowId and is not a content script (no sender.tab).'
	)
}

/**
 * KNOVA: resolve (or lazily create) the DEDICATED window all agent work happens in, so the agent
 * never opens tabs in the window the user is reading.
 *
 * The marker is the HUB TAB, not a saved id. The previous version persisted the numeric windowId
 * in storage.local, which is wrong in a way that only shows up after a browser restart: Chrome
 * window ids are PER-SESSION. After a restart the saved id is either
 *   (a) gone      → we created a brand-new agent window on every launch, and since session-restore
 *                   also brings the OLD agent window back, the windows multiplied one per restart
 *                   (Leo saw three), or
 *   (b) REUSED    → the id now belongs to one of the user's own restored windows, and every agent
 *                   tab opens right in the window he is reading. That is the exact failure this
 *                   window exists to prevent, and it is silent.
 *
 * The hub tab survives restore, lives only in the agent window, and is guaranteed to exist by the
 * keepalive alarm — so it is a durable marker with no state to go stale. No storage key at all.
 */
/**
 * KNOVA: find our hub tabs WITHOUT a match pattern. `tabs.query({url})` takes a match pattern, and
 * match patterns officially cover http/https/file/ftp/urn — `chrome-extension://` is outside that
 * set, so relying on it to find our own page is betting on undocumented behaviour, and an empty
 * result here reads exactly like "no hub exists" and makes the caller open another one. Query all
 * tabs and filter in JS: boring, documented, cannot silently return nothing.
 */
export async function findHubTabs(): Promise<chrome.tabs.Tab[]> {
	const hubUrl = chrome.runtime.getURL('hub.html')

	// MEASURED, not assumed (/tmp/knova-ext.log, 2026-08-03): filtering chrome.tabs.query({}) by
	// `url` returned hubs:[] on EVERY call while totalTabs climbed 2→3→4→5→6→7 — it could not even
	// see the hub it had created 100ms earlier. tabs.query does not populate `url` for these tabs,
	// so the filter matched nothing, every revive concluded "no hub exists", and each one opened
	// another window. Leo ended up with eight. Serializing the revives could not help: each call
	// genuinely found nothing.
	//
	// getContexts() is the API actually meant for "where are my own documents". It reports
	// documentUrl for the extension's own pages and does not depend on tab-url visibility at all.
	let hubs: chrome.tabs.Tab[] = []
	let via = 'none'
	try {
		const ctxs = await chrome.runtime.getContexts?.({
			contextTypes: ['TAB' as chrome.runtime.ContextType],
		})
		const ids = (ctxs ?? [])
			.filter((c) => c.documentUrl?.startsWith(hubUrl))
			.map((c) => c.tabId)
			.filter((id): id is number => typeof id === 'number' && id >= 0)
		if (ids.length > 0) {
			const got = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))
			hubs = got.filter((t): t is chrome.tabs.Tab => t != null)
			via = 'getContexts'
		}
	} catch {
		/* older Chrome, or getContexts unavailable — fall through to the url scan below */
	}

	const all = await chrome.tabs.query({})
	if (hubs.length === 0) {
		// Fallback, and it now also checks pendingUrl (a tab that has not committed navigation
		// reports its target there, not in url).
		hubs = all.filter((t) => t.url?.startsWith(hubUrl) || t.pendingUrl?.startsWith(hubUrl))
		if (hubs.length > 0) via = 'urlScan'
	}

	knovaLog('findHubTabs', {
		via,
		totalTabs: all.length,
		windows: [...new Set(all.map((t) => t.windowId))].length,
		hubs: hubs.map((t) => ({ tabId: t.id, windowId: t.windowId, url: t.url })),
		// raw sample so a future miss is diagnosable in ONE round instead of four
		sample: all
			.slice(0, 12)
			.map((t) => ({ id: t.id, w: t.windowId, url: t.url, pending: t.pendingUrl, title: t.title })),
	})
	return hubs
}

export function handleTabControlMessage(
	message: { type: 'TAB_CONTROL'; action: TabAction; payload: any },
	sender: chrome.runtime.MessageSender,
	sendResponse: (response: unknown) => void
): true | undefined {
	const { action, payload } = message

	switch (action as TabAction) {
		case 'get_active_tab': {
			debug('get_active_tab', payload)
			resolveActiveTab(payload, sender)
				.then((tab) => {
					debug('get_active_tab: success', tab)
					sendResponse({ success: true, tab })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'get_tab_info': {
			debug('get_tab_info', payload)
			chrome.tabs
				.get(payload.tabId)
				.then((tab) => {
					debug('get_tab_info: success', tab)
					sendResponse(tab)
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		// KNOVA: resolve (or lazily create) a DEDICATED window for agent work, so the agent never
		// opens tabs in the window the user is reading. Created with focused:false so it does not
		// steal focus, and reused across tasks — the user can minimise it once and forget it.
		case 'open_new_tab': {
			debug('open_new_tab', payload)
			chrome.tabs
				.create({ url: payload.url, windowId: payload.windowId, active: false })
				.then((newTab) => {
					debug('open_new_tab: success', newTab)
					sendResponse({ success: true, tabId: newTab.id })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'create_tab_group': {
			debug('create_tab_group', payload)
			chrome.tabs
				.group({ tabIds: payload.tabIds, createProperties: { windowId: payload.windowId } })
				.then((groupId) => {
					debug('create_tab_group: success', groupId)
					sendResponse({ success: true, groupId })
				})
				.catch((error) => {
					console.error(PREFIX, 'Failed to create tab group', error)
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'update_tab_group': {
			debug('update_tab_group', payload)
			chrome.tabGroups
				.update(payload.groupId, payload.properties)
				.then(() => {
					sendResponse({ success: true })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'add_tab_to_group': {
			debug('add_tab_to_group', payload)
			chrome.tabs
				.group({ tabIds: payload.tabId, groupId: payload.groupId })
				.then(() => {
					sendResponse({ success: true })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'close_tab': {
			debug('close_tab', payload)
			chrome.tabs
				.remove(payload.tabId)
				.then(() => {
					sendResponse({ success: true })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'get_window_tabs': {
			chrome.tabs
				.query({ windowId: payload.windowId })
				.then((tabs) => {
					sendResponse({ success: true, tabs })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true
		}

		default:
			sendResponse({ error: `Unknown action: ${action}` })
			return
	}
}
