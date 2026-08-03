import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Leo's actual state: eight leftover hub windows from the multiplication era. Under the lazy
// model nothing runs at startup, so the collapse happens on the next OPEN_HUB (i.e. the next
// cloud task). Asserts: hubs collapse to ONE, and Leo's own tab is untouched.
const HUB = 'chrome-extension://fake/hub.html'
const ext = []
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
		onMessageExternal: { addListener: (f) => ext.push(f) },
		onStartup: L,
		onInstalled: L,
		getURL: (p) => `chrome-extension://fake/${p}`,
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
}
globalThis.self = globalThis
await import(pathToFileURL(resolve(process.argv[2])).href)

// idle: nothing may have happened yet
if (tabs.filter((t) => String(t.url).startsWith(HUB)).length !== 8) {
	console.log('❌ FAIL — something ran at startup under the lazy model')
	process.exit(1)
}

// a cloud task arrives → the worker opens the launcher → launcher sends OPEN_HUB
tabs.push({ id: 98, windowId: 99, url: 'http://localhost:38401/' })
await new Promise((res) =>
	ext.forEach((f) => f({ type: 'OPEN_HUB', wsPort: 38401 }, { tab: { id: 98 } }, res))
)
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
