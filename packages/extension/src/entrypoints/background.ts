import { handlePageControlMessage } from '@/agent/RemotePageController.background'
import { findHubTabs, handleTabControlMessage, knovaLog } from '@/agent/TabsController.background'

export default defineBackground(() => {
	console.log('[Background] Service Worker started')

	// generate user auth token

	chrome.storage.local.get('PageAgentExtUserAuthToken').then((result) => {
		if (result.PageAgentExtUserAuthToken) return

		const userAuthToken = crypto.randomUUID()
		chrome.storage.local.set({ PageAgentExtUserAuthToken: userAuthToken })
	})

	// message proxy

	chrome.runtime.onMessage.addListener((message, sender, sendResponse): true | undefined => {
		if (message.type === 'TAB_CONTROL') {
			return handleTabControlMessage(message, sender, sendResponse)
		} else if (message.type === 'PAGE_CONTROL') {
			return handlePageControlMessage(message, sender, sendResponse)
		} else {
			sendResponse({ error: 'Unknown message type' })
			return
		}
	})

	// external messages (from localhost launcher page via externally_connectable)

	chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
		if (message.type === 'OPEN_HUB') {
			knovaLog('OPEN_HUB', { wsPort: message.wsPort })
			openOrFocusHubTab(message.wsPort).then(() => {
				if (sender.tab?.id) chrome.tabs.remove(sender.tab.id)
				sendResponse({ ok: true })
			})
			return true
		}
	})

	// setup

	chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

	// KNOVA — LAZY HUB (Leo's model, stated 2026-08-03, replacing six rounds of the opposite):
	//   "打开 Chrome 的时候,就只是一个干干净净的 window。当有要求发过来的时候,你再根据需求开
	//    这个 PageAgent designated window。没有就 create,有就沿用。"
	// So the extension does NOTHING at startup, install, reload, or on a timer. The revive-on-start
	// machinery (onStartup/onInstalled/top-level revive + keepalive alarm, v9–v16) is deleted — the
	// telemetry showed it working exactly as written, and what it was written to do was the opposite
	// of the requirement. The hub now opens on demand only: when a cloud task arrives and the hub is
	// not connected, the WORKER opens http://localhost:38401 (the MCP's launcher page); that page
	// sends OPEN_HUB here via externally_connectable; the handler above creates or reuses the hub —
	// alone in its own window — and closes the launcher tab. Idle Chrome shows nothing of ours.
})

async function openOrFocusHubTab(wsPort: number) {
	const hubUrl = chrome.runtime.getURL('hub.html')
	const existing = await findHubTabs()

	// KNOVA: the hub belongs in the agent window, never the user's. Upstream created it with
	// `pinned: true` and no windowId — which is why it always appeared pinned at the far LEFT of
	// whatever window the user was reading — and re-focused it with `active: true`.

	if (existing.length > 0 && existing[0].id) {
		// KNOVA: NEVER reload a hub that is already correct. This function runs on every service
		// worker start, and MV3 restarts the worker constantly — the keepalive alarm alone wakes
		// it once a minute, which re-runs the top-level reviveHub(). With an unconditional
		// tabs.update() that reloaded the LIVE hub every 60s, dropping its WebSocket each time.
		// Measured before the fix: disconnect/connect pairs at 22s / 82s / 144s with no task
		// running, and a real task that died with "Hub disconnected while task was running".
		// The revive path has to be IDEMPOTENT(幂等) — running it again must be a no-op.
		const want = `${hubUrl}?ws=${wsPort}`

		// THE INVARIANT that replaces the whole get_agent_window layer: the hub tab sits ALONE in
		// its own window. Upstream then routes every agent tab to the hub's window (TabsController
		// runs inside the hub page, so windows.getCurrent() IS that window) with active:false — so
		// "never touch the window Leo is reading" comes for free, with no second window factory.
		// The one case that breaks it is Leo opening the hub url by hand in his working window;
		// moving it out is a single call and makes the invariant self-healing.
		const roommates = (
			await chrome.tabs.query({ windowId: existing[0].windowId }).catch(() => [])
		).filter((t) => t.id !== existing[0].id)
		if (roommates.length > 0) {
			knovaLog('hub:evicting', { from: existing[0].windowId, roommates: roommates.length })
			await chrome.windows.create({ tabId: existing[0].id, focused: false }).catch(() => {})
		}

		knovaLog('hub:reuse', {
			tabId: existing[0].id,
			windowId: existing[0].windowId,
			urlMatches: existing[0].url === want,
			duplicates: existing.length - 1,
		})
		if (existing[0].url !== want) await chrome.tabs.update(existing[0].id, { url: want }) // no active:true

		// ONE hub, ONE window. Extra hubs are the leftovers of the stale-windowId bug: a saved
		// numeric windowId does not survive a browser restart, so every launch made a FRESH agent
		// window while session-restore brought the old one back too — Leo counted three. Each extra
		// hub also fights for the single MCP connection. Drop the duplicates, and take their window
		// with them when nothing but our own scratch tabs is left in it.
		for (const dup of existing.slice(1)) {
			if (dup.id == null) continue
			await chrome.tabs.remove(dup.id).catch(() => {})
			if (dup.windowId == null) continue
			const rest = await chrome.tabs.query({ windowId: dup.windowId }).catch(() => [])
			const ours = (t: chrome.tabs.Tab) =>
				t.url === 'about:blank' ||
				t.url === '' ||
				!!t.url?.startsWith(hubUrl) ||
				!!t.url?.startsWith('chrome://newtab')
			const collapse = rest.length > 0 && rest.every(ours)
			knovaLog('hub:duplicate', {
				tabId: dup.id,
				windowId: dup.windowId,
				leftoverUrls: rest.map((t) => t.url),
				closingWindow: collapse,
			})
			if (collapse) await chrome.windows.remove(dup.windowId).catch(() => {})
		}
		return
	}

	// No hub anywhere → give it its OWN window immediately. Creating the window WITH the hub url
	// (rather than about:blank and then a tab) is also what stops the stray about:blank appearing.
	const created = await chrome.windows.create({ url: `${hubUrl}?ws=${wsPort}`, focused: false })
	knovaLog('hub:created-window', { windowId: created?.id })
}
