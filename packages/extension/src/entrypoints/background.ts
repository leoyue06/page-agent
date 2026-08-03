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
			if (typeof knovaHubWsPort === 'number') void openOrFocusHubTab(knovaHubWsPort)
		})
	}
	chrome.runtime.onStartup.addListener(reviveHub)
	chrome.runtime.onInstalled.addListener(reviveHub)
	reviveHub() // service worker just woke up (e.g. after a reload) — bring it back now too
})

async function openOrFocusHubTab(wsPort: number) {
	const hubUrl = chrome.runtime.getURL('hub.html')
	const existing = await chrome.tabs.query({ url: `${hubUrl}*` })

	// KNOVA: the hub belongs in the agent window, never the user's. Upstream created it with
	// `pinned: true` and no windowId — which is why it always appeared pinned at the far LEFT of
	// whatever window the user was reading — and re-focused it with `active: true`.
	const windowId = await getAgentWindowId().catch(() => undefined)

	if (existing.length > 0 && existing[0].id) {
		await chrome.tabs.update(existing[0].id, { url: `${hubUrl}?ws=${wsPort}` }) // no active:true
		if (windowId != null && existing[0].windowId !== windowId) {
			await chrome.tabs.move(existing[0].id, { windowId, index: -1 }).catch(() => {})
		}
		return
	}

	await chrome.tabs.create({ url: `${hubUrl}?ws=${wsPort}`, windowId, active: false })
}
