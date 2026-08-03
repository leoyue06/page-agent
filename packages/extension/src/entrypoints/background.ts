import { handlePageControlMessage } from '@/agent/RemotePageController.background'
import { findHubTabs, handleTabControlMessage } from '@/agent/TabsController.background'

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
			// KNOVA: remember the port so the hub can revive itself on the next browser start
			// without the user having to visit the launcher URL by hand.
			void chrome.storage.local.set({ knovaHubWsPort: message.wsPort })
			openOrFocusHubTab(message.wsPort).then(() => {
				if (sender.tab?.id) chrome.tabs.remove(sender.tab.id)
				sendResponse({ ok: true })
			})
			return true
		}
	})

	// setup

	chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

	// KNOVA: the hub is infrastructure — it should start itself. Upstream only ever opened it when
	// the localhost launcher page asked, so every browser restart, extension reload or lid-close
	// left the user typing localhost:PORT by hand and then dragging the tab out of their working
	// window. Revive it on startup and on install/update, in the agent window, unfocused.
	// SERIALIZED, and that is the whole fix for the multiplying windows. reviveHub has THREE
	// triggers that all fire within the same tick: on a reload, onInstalled AND the top-level call
	// below; on a browser start, onStartup AND the top-level call. Each one did
	//     query for a hub  →  await  →  create one if absent
	// so every trigger looked before any of them had acted, all of them saw "no hub", and each
	// created its own window. Together with the window session-restore brings back, that is exactly
	// the three windows Leo kept getting — a classic check-then-act race, NOT a leak, which is why
	// the duplicate-collapsing added earlier never fired: at check time there was nothing to
	// collapse yet.
	//
	// Chaining the calls makes the second and third see the window the first created and no-op.
	let reviveChain: Promise<unknown> = Promise.resolve()
	const reviveHub = () => {
		reviveChain = reviveChain
			.then(async () => {
				const { knovaHubWsPort } = await chrome.storage.local.get('knovaHubWsPort')
				// Default to the MCP's own default port. Gating this on "have we stored a port"
				// meant a fresh install did nothing at all — the key is only written when the
				// launcher page sends OPEN_HUB, so before the user's first manual visit the revive
				// was a silent no-op, indistinguishable from the feature not existing.
				const port = typeof knovaHubWsPort === 'number' ? knovaHubWsPort : 38401
				console.log('[KNOVA] reviving hub on port', port)
				await openOrFocusHubTab(port)
			})
			.catch((e) => console.warn('[KNOVA] revive failed', e))
	}
	chrome.runtime.onStartup.addListener(reviveHub)
	chrome.runtime.onInstalled.addListener(reviveHub)
	reviveHub() // service worker just woke up (e.g. after a reload) — bring it back now too

	// The three hooks above are not enough on their own: if the user CLOSES the hub tab, nothing
	// happens afterwards to wake this service worker, so the hub stays dead and the next task
	// fails with "Extension hub never connected" — the user then has to visit localhost:PORT by
	// hand, which is the manual step all of this exists to remove. An alarm is the MV3 way to get
	// a periodic wake-up; it fires roughly every minute and only acts when the hub is missing.
	// GUARDED, and the guard is the point. This runs at the TOP LEVEL of an MV3 service worker,
	// where a throw does not just skip the keepalive — it fails service-worker registration, and
	// the worker is the spine of the whole chain (every TAB_CONTROL / PAGE_CONTROL message routes
	// through it). One missing optional API therefore took down the entire extension.
	//
	// Measured 2026-08-02 from Chrome's own Secure Preferences: granted_permissions.api DID list
	// "alarms", but the manifest snapshot Chrome had loaded did NOT — the reload had not picked up
	// the new manifest from disk. So chrome.alarms was undefined, `.create` threw, registration
	// failed with status 15 (kErrorScriptEvaluateFailed), and the symptom Leo saw was a dead
	// extension with a hub that never came back.
	//
	// Degrading to "no keepalive" is survivable; taking the spine down is not.
	if (chrome.alarms?.create) {
		chrome.alarms.create('knova-hub-keepalive', { periodInMinutes: 1 })
		chrome.alarms.onAlarm.addListener((alarm) => {
			if (alarm.name !== 'knova-hub-keepalive') return
			void findHubTabs().then((tabs) => {
				if (tabs.length === 0) reviveHub()
			})
		})
	} else {
		console.warn('[KNOVA] chrome.alarms unavailable — hub keepalive disabled for this session')
	}
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
			const ours = (t: chrome.tabs.Tab) => t.url === 'about:blank' || !!t.url?.startsWith(hubUrl)
			if (rest.length > 0 && rest.every(ours)) {
				await chrome.windows.remove(dup.windowId).catch(() => {})
			}
		}
		return
	}

	// No hub anywhere → give it its OWN window immediately. Creating the window WITH the hub url
	// (rather than about:blank and then a tab) is also what stops the stray about:blank appearing.
	await chrome.windows.create({ url: `${hubUrl}?ws=${wsPort}`, focused: false })
}
