import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Pins Leo's model (2026-08-03), which replaced revive-on-startup:
//   1. Chrome startup / extension reload / install → the extension creates NOTHING.
//   2. First OPEN_HUB (a cloud task arrived) → exactly ONE hub window, launcher tab closed.
//   3. Second OPEN_HUB → REUSE, no new window.
const HUB = 'chrome-extension://fake/hub.html'
const listeners = { startup: [], installed: [], external: [] }
let tabs = [{ id: 90, windowId: 90, url: 'https://mail.google.com/' }] // Leo's working window
const created = []
let nextId = 100
const L = { addListener: () => {} }
const tick = () => new Promise((r) => setTimeout(r, 0))

globalThis.chrome = {
	runtime: {
		onMessage: L,
		onMessageExternal: { addListener: (f) => listeners.external.push(f) },
		onStartup: { addListener: (f) => listeners.startup.push(f) },
		onInstalled: { addListener: (f) => listeners.installed.push(f) },
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
			await tick()
			const id = nextId++
			created.push(o?.url ?? '(tabId move)')
			if (o?.url) tabs.push({ id: nextId++, windowId: id, url: o.url })
			return { id }
		},
		get: async () => ({ id: 1 }),
		remove: async (id) => {
			tabs = tabs.filter((t) => t.windowId !== id)
		},
		getCurrent: async () => ({ id: 1 }),
	},
}
globalThis.self = globalThis

await import(pathToFileURL(resolve(process.argv[2])).href)
listeners.startup.forEach((f) => f())
listeners.installed.forEach((f) => f())
await new Promise((r) => setTimeout(r, 150))

if (created.length !== 0) {
	console.log(
		`❌ FAIL — startup/reload created ${created.length} window(s): ${JSON.stringify(created)}`
	)
	process.exit(1)
}
console.log('✅ startup/reload/install created NOTHING')

// a cloud task arrives → launcher page sends OPEN_HUB
tabs.push({ id: 91, windowId: 90, url: 'http://localhost:38401/' }) // launcher opened by the worker
const send = (msg) =>
	new Promise((r) => listeners.external.forEach((f) => f(msg, { tab: { id: 91 } }, r)))
await send({ type: 'OPEN_HUB', wsPort: 38401 })
await new Promise((r) => setTimeout(r, 150))
const hubs1 = tabs.filter((t) => String(t.url).startsWith(HUB))
if (created.length !== 1 || hubs1.length !== 1) {
	console.log(`❌ FAIL — first OPEN_HUB: created=${created.length} hubs=${hubs1.length}`)
	process.exit(1)
}
console.log('✅ first OPEN_HUB → exactly one hub window')

await send({ type: 'OPEN_HUB', wsPort: 38401 })
await new Promise((r) => setTimeout(r, 150))
const hubs2 = tabs.filter((t) => String(t.url).startsWith(HUB))
const leoTab = tabs.filter((t) => t.id === 90)
if (created.length !== 1 || hubs2.length !== 1 || leoTab.length !== 1) {
	console.log(
		`❌ FAIL — second OPEN_HUB: created=${created.length} hubs=${hubs2.length} leoTab=${leoTab.length}`
	)
	process.exit(1)
}
console.log('✅ second OPEN_HUB → reused, no new window, user tab untouched')

// a task ran and put its tab in the hub's window — that is the DESIGN, not an intrusion.
// v16's "hub sits alone" invariant evicted the hub here (measured on Leo's machine:
// hub:evicting roommates:1 splitting the hub from its own task tab). Pin the fix:
const hubTab = tabs.find((t) => String(t.url).startsWith(HUB))
tabs.push({ id: 500, windowId: hubTab.windowId, url: 'https://example.com/' })
await send({ type: 'OPEN_HUB', wsPort: 38401 })
await new Promise((r) => setTimeout(r, 150))
const hubAfter = tabs.find((t) => String(t.url).startsWith(HUB))
const taskTab = tabs.find((t) => t.id === 500)
if (
	created.length !== 1 ||
	hubAfter.windowId !== hubTab.windowId ||
	!taskTab ||
	taskTab.windowId !== hubTab.windowId
) {
	console.log(
		`❌ FAIL — third OPEN_HUB with a task tab present: created=${created.length} hubWindow=${hubAfter?.windowId} (was ${hubTab.windowId}) taskTabWindow=${taskTab?.windowId}`
	)
	process.exit(1)
}
console.log(
	'✅ third OPEN_HUB with a task tab in the hub window → hub STAYS, tab stays, no eviction'
)
