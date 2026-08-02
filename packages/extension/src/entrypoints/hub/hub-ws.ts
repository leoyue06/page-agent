/**
 * Hub WebSocket Protocol
 *
 * Hub connects as WS client to `ws://localhost:{port}`.
 * All messages are JSON. One task at a time.
 *
 * Inbound (Caller → Hub):
 *   { type: "execute", task: string, config?: object }
 *   { type: "stop" }
 *
 * Outbound (Hub → Caller):
 *   { type: "ready" }
 *   { type: "activity", activity: AgentActivity }          // KNOVA: live step trace
 *   { type: "result", success: boolean, data: string, history?: HistoricalEvent[] }
 *   { type: "error", message: string }
 *
 * KNOVA fork note (2026-08-01): upstream only ever sent `result.data`, so a caller
 * driving the hub over MCP saw a task go silent and come back "fail" with no way to
 * tell WHY — the step-by-step trace existed but was rendered locally and never left
 * the browser. Two additions, both purely additive so upstream rebases stay small:
 *   · `activity` — pushed as each step happens, so the caller can decide WHEN to stop
 *   · `history`  — the full ExecutionResult.history, which was being discarded
 */
import type { AgentActivity, ExecutionResult, HistoricalEvent } from '@page-agent/core'
import { useEffect, useRef, useState } from 'react'

import type { ExtConfig } from '@/agent/useAgent'

// --- Protocol types ---

interface ExecuteMessage {
	type: 'execute'
	task: string
	config?: Record<string, unknown>
}

interface StopMessage {
	type: 'stop'
}

type InboundMessage = ExecuteMessage | StopMessage

interface ReadyMessage {
	type: 'ready'
}

interface ResultMessage {
	type: 'result'
	success: boolean
	data: string
	/** KNOVA: full step trace. Upstream dropped this — it is what makes a failure diagnosable. */
	history?: HistoricalEvent[]
}

/** KNOVA: one step, pushed live while the task runs. */
interface ActivityMessage {
	type: 'activity'
	activity: AgentActivity
}

interface ErrorMessage {
	type: 'error'
	message: string
}

type OutboundMessage = ReadyMessage | ActivityMessage | ResultMessage | ErrorMessage

export type HubWsState = 'connecting' | 'connected' | 'disconnected'

// --- HubWs class ---

export interface HubWsHandlers {
	onExecute: (
		task: string,
		config?: Record<string, unknown>
	) => Promise<{ success: boolean; data: string; history?: HistoricalEvent[] }>
	onStop: () => void
}

/**
 * Framework-agnostic WebSocket client for Hub.
 * Connects to an external WS server, receives tasks, dispatches to handlers,
 * and sends results back. No React, no DOM.
 */
export class HubWs {
	#ws: WebSocket | null = null
	#state: HubWsState = 'disconnected'
	#busy = false
	#approved = false
	#handlers: HubWsHandlers
	#port: number
	#onStateChange: (state: HubWsState) => void

	constructor(port: number, handlers: HubWsHandlers, onStateChange: (state: HubWsState) => void) {
		this.#port = port
		this.#handlers = handlers
		this.#onStateChange = onStateChange
	}

	get state() {
		return this.#state
	}

	get busy() {
		return this.#busy
	}

	connect() {
		if (this.#ws) return
		this.#setState('connecting')

		const ws = new WebSocket(`ws://localhost:${this.#port}`)
		this.#ws = ws

		ws.addEventListener('open', () => {
			this.#setState('connected')
			this.#send({ type: 'ready' })
		})

		ws.addEventListener('close', () => {
			this.#ws = null
			this.#busy = false
			this.#approved = false
			this.#setState('disconnected')
		})

		ws.addEventListener('message', (event) => {
			this.#handleMessage(event.data as string)
		})
	}

	disconnect() {
		this.#ws?.close()
		this.#ws = null
		this.#busy = false
		this.#approved = false
		this.#setState('disconnected')
	}

	#setState(state: HubWsState) {
		if (this.#state === state) return
		this.#state = state
		this.#onStateChange(state)
	}

	#send(msg: OutboundMessage) {
		if (this.#ws?.readyState === WebSocket.OPEN) {
			this.#ws.send(JSON.stringify(msg))
		}
	}

	async #handleMessage(raw: string) {
		let msg: InboundMessage
		try {
			msg = JSON.parse(raw)
		} catch {
			return
		}

		if (!(await this.#checkApproval())) {
			this.#send({ type: 'error', message: 'User denied the connection request.' })
			return
		}

		switch (msg.type) {
			case 'execute':
				this.#handleExecute(msg)
				break
			case 'stop':
				this.#handlers.onStop()
				break
		}
	}

	async #checkApproval(): Promise<boolean> {
		if (this.#approved) return true

		const { allowAllHubConnection } = await chrome.storage.local.get('allowAllHubConnection')
		if (allowAllHubConnection === true) {
			this.#approved = true
			return true
		}

		const ok = window.confirm(
			'An external application is requesting to control your browser via Page Agent Ext.\nAllow this session?'
		)
		if (ok) this.#approved = true
		return ok
	}

	/** KNOVA: push one live step to the caller. No-op unless a task is running. */
	sendActivity(activity: AgentActivity) {
		if (this.#busy) this.#send({ type: 'activity', activity })
	}

	async #handleExecute(msg: ExecuteMessage) {
		if (this.#busy) {
			this.#send({ type: 'error', message: 'Hub is busy with another task' })
			return
		}

		this.#busy = true
		try {
			const result = await this.#handlers.onExecute(msg.task, msg.config)
			this.#send({
				type: 'result',
				success: result.success,
				data: result.data,
				history: result.history,
			})
		} catch (err) {
			this.#send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
		} finally {
			this.#busy = false
		}
	}
}

// --- React hook ---

/**
 * React hook that bridges HubWs to the agent's execute/stop/configure.
 * Handles the config-before-execute dance internally.
 */
export function useHubWs(
	execute: (task: string) => Promise<ExecutionResult>,
	stop: () => void,
	configure: (config: ExtConfig) => Promise<void>,
	config: ExtConfig | null,
	/** KNOVA: current step from useAgent(); forwarded to the caller as it changes. */
	activity?: AgentActivity | null
): { wsState: HubWsState } {
	const wsPort = new URLSearchParams(location.search).get('ws')
	const [wsState, setWsState] = useState<HubWsState>(() => (wsPort ? 'connecting' : 'disconnected'))
	const hubWsRef = useRef<HubWs | null>(null)

	const latestRef = useRef({ execute, stop, configure, config })
	const lastConfigRef = useRef<string>('') // KNOVA: dedupe configure calls (see onExecute)
	useEffect(() => {
		latestRef.current = { execute, stop, configure, config }
	})

	useEffect(() => {
		if (!wsPort) return

		const hubWs = new HubWs(
			Number(wsPort),
			{
				onExecute: async (task, incomingConfig) => {
					const { execute, configure, config } = latestRef.current
					// KNOVA fix — upstream race: configure() → setConfig → the [config] effect
					// recreates the agent and its cleanup DISPOSES the old one, killing the task
					// execute() just started ("Task aborted" at ~0.1s, hit whenever the MCP passes
					// an env LLM config). Two guards: skip configure when the config is unchanged,
					// and after a real change wait for the recreated agent before executing.
					if (incomingConfig && lastConfigRef.current !== JSON.stringify(incomingConfig)) {
						await configure({ ...config, ...incomingConfig } as ExtConfig)
						lastConfigRef.current = JSON.stringify(incomingConfig)
						await new Promise((r) => setTimeout(r, 300)) // let the [config] effect swap agents
					}
					const result = await execute(task)
					return { success: result.success, data: result.data, history: result.history }
				},
				onStop: () => latestRef.current.stop(),
			},
			setWsState
		)

		hubWs.connect()
		hubWsRef.current = hubWs

		return () => {
			hubWs.disconnect()
			hubWsRef.current = null
		}
	}, [wsPort])

	// KNOVA: forward every step as it happens. useAgent() already tracks `activity`;
	// upstream just never sent it anywhere but the local UI.
	useEffect(() => {
		if (activity) hubWsRef.current?.sendActivity(activity)
	}, [activity])

	return { wsState }
}
