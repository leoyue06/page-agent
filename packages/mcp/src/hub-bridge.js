#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const EXT_ID = 'akldabonmimlicnjlflnapfeklbfemhj'
const STORE_URL = `https://chromewebstore.google.com/detail/page-agent-ext/${EXT_ID}`
const LOOPBACK_HOST = 'localhost'

const launcherTemplate = readFileSync(
	fileURLToPath(new URL('./launcher.html', import.meta.url)),
	'utf-8'
)

/**
 * HTTP + WebSocket bridge to the hub.html extension tab.
 * - HTTP serves the launcher page (triggers extension to open hub)
 * - WS carries execute/stop commands and result/error responses
 */
const LOOP_LIMIT = 6 // KNOVA: 6 identical calls in a row = stuck. High enough that 2-3 legit
// repeats never trip it; low enough that the §18.5 case costs ~30s instead of 213s.

export class HubBridge {
	/** @type {number} */
	port

	/** @type {http.Server} */
	#httpServer

	/** @type {WebSocketServer} */
	#wss

	/** @type {import('ws').WebSocket | null} */
	#hub = null

	/** @type {{ resolve: (r: {success: boolean, data: string, history?: unknown[]}) => void, reject: (e: Error) => void } | null} */
	#pendingTask = null

	/** KNOVA: live step trace for the task in flight — get_status exposes it so the caller
	 *  can watch progress and decide when to stop_task, instead of waiting out a silent
	 *  30s and getting an undiagnosable "fail". Cleared when a new task starts. */
	/** @type {unknown[]} */
	#activities = []

	/** KNOVA loop breaker. The agent has NO loop detection of its own: a Gmail compose test
	 *  clicked the SAME "Maximize" button 20 times in a row and burned 213s before giving up
	 *  (page-agent-integration-log.html §18.5). stop_task aborts in ~0.1s — measured — so the
	 *  missing piece was never the brake, only something willing to pull it. Living HERE (not in
	 *  the MCP client) means it also protects `claude -p`, which is blocked on execute_task and
	 *  structurally cannot stop anything itself. Signature = tool + its input, so legitimate
	 *  repetition (three scrolls of different distances) never trips it. */
	#loopSig = null
	#loopCount = 0
	/** @type {string | null} set when WE pulled the brake, so "aborted" stays distinguishable
	 *  from a user-requested stop — otherwise a broken loop reads as a mysterious cancel. */
	#loopBroken = null

	/** @param {number} port */
	constructor(port) {
		this.port = port
		this.#httpServer = http.createServer((_req, res) => {
			const html = launcherTemplate
				.replaceAll('__EXT_ID__', EXT_ID)
				.replaceAll('__STORE_URL__', STORE_URL)
				.replaceAll('__WS_PORT__', String(port))
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			res.end(html)
		})
		this.#wss = new WebSocketServer({ server: this.#httpServer })
		this.#wss.on('connection', (ws) => this.#onConnection(ws))
	}

	/** @returns {Promise<void>} */
	async start() {
		return new Promise((resolve, reject) => {
			this.#httpServer.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
				if (err.code === 'EADDRINUSE') {
					reject(
						new Error(`Port ${this.port} is in use. Another Page Agent MCP server may be running.`)
					)
				} else {
					reject(err)
				}
			})
			this.#httpServer.listen(this.port, LOOPBACK_HOST, () => {
				console.error(`[page-agent-mcp] HTTP + WS on http://${LOOPBACK_HOST}:${this.port}`)
				resolve()
			})
		})
	}

	get connected() {
		return this.#hub?.readyState === 1
	}

	get busy() {
		return this.#pendingTask !== null
	}

	/** KNOVA: steps observed so far for the task in flight (or the last one). */
	get activities() {
		return this.#activities
	}

	/** KNOVA: non-null when the loop breaker stopped this task (vs a user-requested stop). */
	get loopBroken() {
		return this.#loopBroken
	}

	/**
	 * @param {string} task
	 * @param {Record<string, unknown>} [config]
	 * @returns {Promise<{success: boolean, data: string}>}
	 */
	async executeTask(task, config) {
		if (!this.connected) throw new Error('Hub is not connected. Is the extension running?')
		if (this.#pendingTask) throw new Error('Agent is already running a task.')

		this.#activities = [] // KNOVA: fresh trace per task
		this.#loopSig = null // KNOVA: and a fresh loop-breaker window
		this.#loopCount = 0
		this.#loopBroken = null
		return new Promise((resolve, reject) => {
			this.#pendingTask = { resolve, reject }
			this.#hub.send(JSON.stringify({ type: 'execute', task, config }))
		})
	}

	stopTask() {
		if (this.connected) {
			this.#hub.send(JSON.stringify({ type: 'stop' }))
		}
	}

	// TODO: Add version checking

	/** @param {import('ws').WebSocket} ws */
	#onConnection(ws) {
		if (this.#hub && this.#hub.readyState === 1) {
			ws.close(4000, 'Another hub is already connected')
			return
		}

		this.#hub = ws
		console.error('[page-agent-mcp] Hub connected')

		ws.on('message', (/** @type {Buffer} */ rawData) => {
			/** @type {{ type: string, success?: boolean, data?: string, message?: string }} */
			let msg
			try {
				msg = JSON.parse(rawData.toString('utf-8'))
			} catch {
				return
			}

			if (msg.type === 'activity') {
				this.#activities.push({ at: Date.now(), ...msg.activity })
				const a = msg.activity || {}
				console.error(
					`[page-agent-mcp] step: ${a.type}${a.tool ? ' ' + a.tool : ''}${a.attempt ? ` (${a.attempt}/${a.maxAttempts})` : ''}`
				)
				if (a.type === 'executing') {
					const sig = `${a.tool}|${JSON.stringify(a.input)}`
					if (process.env.PA_LOOP_DEBUG) console.error(`[loop] ${this.#loopCount} ${sig}`)
					if (sig === this.#loopSig) {
						this.#loopCount++
						if (this.#loopCount >= LOOP_LIMIT && !this.#loopBroken) {
							this.#loopBroken = `${a.tool} repeated ${this.#loopCount}x with identical input`
							console.error(`[page-agent-mcp] LOOP BREAKER: ${this.#loopBroken} — stopping`)
							this.stopTask()
						}
					} else {
						this.#loopSig = sig
						this.#loopCount = 1
					}
				}
				return
			}
			if (msg.type === 'result') {
				this.#pendingTask?.resolve({
					success: msg.success ?? false,
					data: msg.data ?? '',
					history: msg.history, // KNOVA: upstream discarded this
				})
				this.#pendingTask = null
			} else if (msg.type === 'error') {
				this.#pendingTask?.reject(new Error(msg.message ?? 'Unknown error from hub'))
				this.#pendingTask = null
			}
		})

		ws.on('close', () => {
			console.error('[page-agent-mcp] Hub disconnected')
			if (this.#hub === ws) this.#hub = null
			if (this.#pendingTask) {
				this.#pendingTask.reject(new Error('Hub disconnected while task was running'))
				this.#pendingTask = null
			}
		})
	}
}
