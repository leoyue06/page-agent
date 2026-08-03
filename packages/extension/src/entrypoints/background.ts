import { handlePageControlMessage } from '@/agent/RemotePageController.background'
import { getAgentWindowId, handleTabControlMessage } from '@/agent/TabsController.background'

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
	const reviveHub = () => {
		void chrome.storage.local.get('knovaHubWsPort').then(({ knovaHubWsPort }) => {
			// Default to the MCP's own default port. Gating this on "have we stored a port"
			// meant a fresh install did nothing at all — the key is only written when the
			// launcher page sends OPEN_HUB, so before the user's first manual visit the revive
			// was a silent no-op, indistinguishable from the feature not existing.
			const port = typeof knovaHubWsPort === 'number' ? knovaHubWsPort : 38401
			console.log('[KNOVA] reviving hub on port', port)
			void openOrFocusHubTab(port)
		})
	}
	chrome.runtime.onStartup.addListener(reviveHub)
	chrome.runtime.onInstalled.addListener(reviveHub)
	reviveHub() // service worker just woke up (e.g. after a reload) — bring it back now too

	// The three hooks above are not enough on their own: if the user CLOSES the hub tab, nothing
	// happens afterwards to wake this service worker, so the hub stays dead and the next task
	// fails with "Extension hub never connected" — the user then has to visit localhost:PORT by
	// hand, which is the manual step all of this exists to remove. An alarm is the MV3 way to get
	// a periodic wake-up; it fires roughly every minute and only acts when the hub is missing.
	chrome.alarms.create('knova-hub-keepalive', { periodInMinutes: 1 })
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name !== 'knova-hub-keepalive') return
		void chrome.tabs.query({ url: `${chrome.runtime.getURL('hub.html')}*` }).then((tabs) => {
			if (tabs.length === 0) reviveHub()
		})
	})
})

async function openOrFocusHubTab(wsPort: number) {
	const hubUrl = chrome.runtime.getURL('hub.html')
	const existing = await chrome.tabs.query({ url: `${hubUrl}*` })

	// KNOVA: the hub belongs in the agent window, never the user's. Upstream created it with
	// `pinned: true` and no windowId — which is why it always appeared pinned at the far LEFT of
	// whatever window the user was reading — and re-focused it with `active: true`.
	const windowId = await getAgentWindowId().catch(() => undefined)

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
		if (windowId != null && existing[0].windowId !== windowId) {
			await chrome.tabs.move(existing[0].id, { windowId, index: -1 }).catch(() => {})
		}
		return
	}

	await chrome.tabs.create({ url: `${hubUrl}?ws=${wsPort}`, windowId, active: false })
}
