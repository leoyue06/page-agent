import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Leo's actual state: eight hub windows. One revive must collapse them to one.
const HUB = 'chrome-extension://fake/hub.html'
let tabs = [],
	removedWindows = [],
	nextId = 1
for (let i = 0; i < 8; i++) tabs.push({ id: nextId, windowId: nextId++, url: `${HUB}?ws=38401` })
tabs.push({ id: 99, windowId: 99, url: 'https://news.example.com' }) // Leo's own working window
const L = { addListener: () => {} }
const tick = () => new Promise((r) => setTimeout(r, 0))
globalThis.chrome = {
	runtime: {
		onMessage: L,
		onMessageExternal: L,
		onStartup: L,
		onInstalled: L,
		getURL: (p) => `chrome-extension://fake/${p}`,
		// the real Chrome path: getContexts knows our own pages even when tab.url does not
		getContexts: async () => {
			await tick()
			return tabs
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
		get: async (id) => {
			const t = tabs.find((x) => x.id === id)
			if (!t) throw new Error('no tab')
			return t
		},
		create: async () => ({}),
		update: async () => ({}),
		remove: async (id) => {
			tabs = tabs.filter((t) => t.id !== id)
		},
	},
	tabGroups: {},
	windows: {
		create: async () => ({ id: 500 }),
		get: async () => ({ id: 1 }),
		remove: async (id) => {
			removedWindows.push(id)
			tabs = tabs.filter((t) => t.windowId !== id)
		},
	},
	alarms: { create: () => {}, onAlarm: L },
}
globalThis.self = globalThis
await import(pathToFileURL(resolve(process.argv[2])).href)
await new Promise((r) => setTimeout(r, 300))
const hubs = tabs.filter((t) => String(t.url).startsWith(HUB))
const mine = tabs.filter((t) => t.id === 99)
console.log(
	`hub tabs left: ${hubs.length} | windows closed: ${removedWindows.length} | Leo's tab intact: ${mine.length === 1}`
)
if (hubs.length === 1 && mine.length === 1)
	console.log('✅ PASS — collapsed to one, user tab untouched')
else {
	console.log('❌ FAIL')
	process.exit(1)
}
