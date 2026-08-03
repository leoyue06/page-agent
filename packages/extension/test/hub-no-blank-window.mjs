import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The v16 target: NO code path may create an about:blank / newtab window. During an extension
// reload the hub page is mid-boot and briefly unfindable — that is exactly when the deleted
// get_agent_window layer used to spawn a blank window.
const HUB = 'chrome-extension://fake/hub.html'
let tabs = [{ id: 1, windowId: 1, url: `${HUB}?ws=38401` }] // hub already exists and is alone
const created = []
const L = { addListener: () => {} }
const tick = () => new Promise((r) => setTimeout(r, 0))
let contextsBlind = true // simulate "hub not yet registered"
globalThis.chrome = {
	runtime: {
		onMessage: L,
		onMessageExternal: L,
		onStartup: L,
		onInstalled: L,
		getURL: (p) => `chrome-extension://fake/${p}`,
		getContexts: async () => {
			await tick()
			return contextsBlind
				? []
				: tabs
						.filter((t) => String(t.url).startsWith(HUB))
						.map((t) => ({ documentUrl: t.url, tabId: t.id, windowId: t.windowId }))
		},
	},
	storage: { local: { get: async () => ({}), set: async () => {} } },
	sidePanel: { setPanelBehavior: async () => {} },
	tabs: {
		query: async (q) => {
			await tick()
			return q && q.windowId != null ? tabs.filter((t) => t.windowId === q.windowId) : [...tabs]
		},
		get: async (id) => tabs.find((x) => x.id === id) ?? Promise.reject(new Error('gone')),
		create: async () => ({}),
		update: async () => ({}),
		remove: async (id) => {
			tabs = tabs.filter((t) => t.id !== id)
		},
	},
	tabGroups: {},
	windows: {
		create: async (o) => {
			created.push(o?.url ?? '(tabId move)')
			return { id: 99 }
		},
		get: async () => ({ id: 1 }),
		remove: async () => {},
		getCurrent: async () => ({ id: 1 }),
	},
	alarms: { create: () => {}, onAlarm: L },
}
globalThis.self = globalThis
await import(pathToFileURL(resolve(process.argv[2])).href)
await new Promise((r) => setTimeout(r, 250))
const blanks = created.filter(
	(u) => String(u).includes('about:blank') || String(u).includes('newtab')
)
console.log(`windows created: ${JSON.stringify(created)} | blank windows: ${blanks.length}`)
if (blanks.length === 0) console.log('✅ PASS — no blank window factory left')
else {
	console.log('❌ FAIL — something still spawns blank windows')
	process.exit(1)
}
