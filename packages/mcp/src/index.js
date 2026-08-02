#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { exec } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { platform } from 'node:os'
import * as z from 'zod/v4'

import { HubBridge } from './hub-bridge.js'

const env = process.env
const port = parseInt(env.PORT || '38401')
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** @type {Record<string, string>} */
const llmConfig = {}
if (env.LLM_BASE_URL) llmConfig.baseURL = env.LLM_BASE_URL
if (env.LLM_MODEL_NAME) llmConfig.model = env.LLM_MODEL_NAME
if (env.LLM_API_KEY) llmConfig.apiKey = env.LLM_API_KEY

// --- Hub bridge (HTTP + WebSocket) ---

const hub = new HubBridge(port)
await hub.start()

// Open launcher in default browser
const url = `http://localhost:${port}`
const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start ""' : 'xdg-open'
exec(`${cmd} "${url}"`, (err) => {
	if (err) console.error(`[page-agent-mcp] Could not open browser: ${err.message}`)
})

// --- MCP server (stdio) ---

const mcpServer = new McpServer({ name: 'page-agent', version })

mcpServer.registerTool(
	'execute_task',
	{
		description: "Execute a task in user's browser.",
		inputSchema: {
			task: z
				.string()
				.describe(
					'Task description. Give specific instructions for the task. Steps preferable. And the information you want to get after the task is done.'
				),
		},
	},
	async ({ task }) => {
		try {
			const config = Object.keys(llmConfig).length > 0 ? llmConfig : undefined
			const result = await hub.executeTask(task, config)
			// KNOVA: append the step trace so a failure is diagnosable. Upstream returned
			// only `data`, which made "it tried 20 times and gave up" indistinguishable
			// from "it failed immediately" — see docs/page-agent-integration-log.html §3.
			const steps = hub.activities || []
			const trace = steps.length
				? '\n\n--- Steps (' +
					steps.length +
					') ---\n' +
					steps
						.map(
							(a, i) =>
								`${i + 1}. ${a.type}` +
								(a.tool ? ` · ${a.tool}` : '') +
								(a.attempt ? ` · retry ${a.attempt}/${a.maxAttempts}` : '') +
								(a.duration ? ` · ${a.duration}ms` : '') +
								(a.message ? ` · ${a.message}` : '') +
								(a.output ? `\n   → ${String(a.output).slice(0, 200)}` : '')
						)
						.join('\n')
				: ''
			return {
				content: [
					{
						type: 'text',
						text:
							(result.success
								? `Task completed.\n\n${result.data}`
								: `Task failed.\n\n${result.data}`) + trace,
					},
				],
			}
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Error: ${err.message}` }],
				isError: true,
			}
		}
	}
)

mcpServer.registerTool(
	'get_status',
	{
		description: 'Check the current status of the Page Agent hub.',
	},
	async () => ({
		content: [
			{
				type: 'text',
				// KNOVA: `steps` lets the caller watch a running task and decide when to
				// stop_task, rather than waiting out a silent run and getting only "fail".
				text: JSON.stringify(
					{
						connected: hub.connected,
						busy: hub.busy,
						steps: (hub.activities || []).map((a) => ({
							type: a.type,
							...(a.tool ? { tool: a.tool } : {}),
							...(a.attempt ? { retry: `${a.attempt}/${a.maxAttempts}` } : {}),
							...(a.message ? { message: a.message } : {}),
						})),
					},
					null,
					2
				),
			},
		],
	})
)

mcpServer.registerTool(
	'stop_task',
	{
		description: 'Stop the currently running browser automation task.',
	},
	async () => {
		hub.stopTask()
		return { content: [{ type: 'text', text: 'Stop signal sent.' }] }
	}
)

const transport = new StdioServerTransport()
await mcpServer.connect(transport)
console.error('[page-agent-mcp] MCP server ready (stdio)')
