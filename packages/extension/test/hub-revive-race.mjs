import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Reproduces the three-windows bug: onInstalled + onStartup + the top-level call all fire in the
// same tick. Before serialization each created its own window. Asserts exactly ONE is created.
const listeners = { startup: [], installed: [] }
let tabs = [] // no hub anywhere — a cold browser start
let windowsCreated = 0
const HUB = 'chrome-extension://fake/hub.html'
const tick = () => new Promise((r) => setTimeout(r, 0)) // force real await gaps

globalThis.chrome = {
	runtime: {
		onMessage: { addListener: () => {} },
		onMessageExternal: { addListener: () => {} },
		onStartup: { addListener: (f) => listeners.startup.push(f) },
		onInstalled: { addListener: (f) => listeners.installed.push(f) },
		getURL: (p) => `chrome-extension://fake/${p}`,
	},
	storage: {
		local: {
			get: async () => {
				await tick()
				return {}
			},
			set: async () => {},
		},
	},
	sidePanel: { setPanelBehavior: async () => {} },
	tabs: {
		query: async () => {
			await tick()
			return [...tabs]
		},
		create: async () => ({}),
		update: async () => ({}),
		remove: async () => {},
	},
	tabGroups: {},
	windows: {
		create: async ({ url }) => {
			await tick()
			windowsCreated++
			tabs.push({ id: windowsCreated, url, windowId: windowsCreated })
			return { id: windowsCreated }
		},
		get: async () => ({ id: 1 }),
		remove: async () => {},
	},
	alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
}
globalThis.self = globalThis

await import(pathToFileURL(resolve(process.argv[2])).href) // top-level reviveHub() fires here
listeners.startup.forEach((f) => f()) // browser start fires too
listeners.installed.forEach((f) => f()) // ...and so does install/update
await new Promise((r) => setTimeout(r, 200)) // let every chain settle

const hubs = tabs.filter((t) => String(t.url).startsWith(HUB))
console.log(`windows created: ${windowsCreated} | hub tabs: ${hubs.length}`)
if (windowsCreated === 1 && hubs.length === 1) console.log('✅ PASS — three triggers, ONE window')
else {
	console.log('❌ FAIL — the race is still there')
	process.exit(1)
}
