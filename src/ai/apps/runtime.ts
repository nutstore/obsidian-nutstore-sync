import { appFSMethods, createAppFS } from './capabilities/fs'
import { createAppKV, dispatchAppKV, type AppKVHost } from './capabilities/kv'
import { z } from 'zod/mini'
import createId from '~/utils/create-id'
import type { AppContent } from './source'
import { emptyAppTheme, readAppTheme, type AppTheme } from './theme'
import type { AppLogEvent } from './logs'
import { createAppAI } from './capabilities/ai'
import { bootstrap } from './sandbox'
import { AppAIBridge } from './ai/bridge'
import { AppAIError, type AppAIHost } from './ai/contract'

export type { AppRuntimeAPI } from './sandbox'

const requestSchema = z.object({
	channel: z.string(),
	id: z.number().check(z.int(), z.minimum(1)),
	method: z.string(),
	args: z.array(z.unknown()).check(z.maxLength(3)),
})
export interface RuntimeHost extends AppKVHost {
	fs?: (method: string, args: unknown[]) => Promise<unknown>
	ai?: AppAIHost
	log(event: AppLogEvent): void
	error(message: string): void
}

export interface AppRuntimeFailure {
	message: string
	name?: string
	source?: 'startup' | 'uncaught' | 'unhandled-rejection' | 'runtime'
	stack?: string
	filename?: string
	line?: number
	column?: number
}

const runtimeLogSchema = z.object({
	level: z.enum(['debug', 'info', 'log', 'warn', 'error']),
	source: z.enum([
		'console',
		'startup',
		'uncaught',
		'unhandled-rejection',
		'runtime',
	]),
	message: z.string().check(z.minLength(1), z.maxLength(16_000)),
	stack: z.optional(z.string().check(z.maxLength(16_000))),
	filename: z.optional(z.string().check(z.maxLength(2_000))),
	line: z.optional(z.number().check(z.int(), z.minimum(0))),
	column: z.optional(z.number().check(z.int(), z.minimum(0))),
})
const runtimeFailureSchema = z.object({
	message: z.string().check(z.minLength(1), z.maxLength(16_000)),
	name: z.optional(z.string().check(z.maxLength(200))),
	source: z.optional(
		z.enum(['startup', 'uncaught', 'unhandled-rejection', 'runtime']),
	),
	stack: z.optional(z.string().check(z.maxLength(16_000))),
	filename: z.optional(z.string().check(z.maxLength(2_000))),
	line: z.optional(z.number().check(z.int(), z.minimum(0))),
	column: z.optional(z.number().check(z.int(), z.minimum(0))),
})

export function formatAppRuntimeFailure(failure: AppRuntimeFailure) {
	const location = failure.filename
		? ` (${failure.filename}:${failure.line ?? 1}:${failure.column ?? 1})`
		: ''
	const header = `${failure.name ?? 'Error'}: ${failure.message}${location}`
	const stack = failure.stack?.trim()
	if (!stack || stack.includes(failure.message)) return stack || header
	return `${header}\n${stack}`
}

export function runtimeDocument(
	content: AppContent,
	channel: string,
	theme: AppTheme = emptyAppTheme(),
) {
	if (!/^[a-zA-Z0-9]+$/.test(channel))
		throw new Error('Invalid App runtime identity')
	const payload = JSON.stringify({
		channel,
		nonce: channel,
		...content,
		theme,
		fsMethods: appFSMethods,
	}).replace(/</g, '\\u003c')
	const policy = `default-src 'none'; script-src 'nonce-${channel}'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html{color-scheme:light dark}body{margin:0;padding:16px;color:var(--text-normal,CanvasText);background:var(--background-primary,Canvas);font-family:var(--font-interface,var(--font-text,system-ui,sans-serif));font-size:var(--font-ui-medium,14px);line-height:1.5}*{box-sizing:border-box}button,input,textarea,select{font:inherit;color:var(--text-normal,CanvasText)}button{background:var(--interactive-normal,var(--background-secondary,ButtonFace));border:1px solid var(--background-modifier-border,ButtonBorder);border-radius:var(--button-radius,var(--radius-s,6px));padding:6px 12px}button:hover{background:var(--interactive-hover,var(--background-modifier-hover,ButtonFace))}input,textarea,select{background:var(--background-modifier-form-field,var(--background-primary,Field));border:1px solid var(--background-modifier-border,ButtonBorder);border-radius:var(--input-radius,var(--radius-s,6px));padding:6px 8px}a{color:var(--link-color,var(--text-accent,LinkText))}a:hover{color:var(--link-color-hover,var(--text-accent-hover,LinkText))}::selection{background:var(--text-selection,Highlight)}img,canvas,svg{max-width:100%}</style><style data-app-styles></style></head><body><script nonce="${channel}">(${bootstrap.toString()})(${payload}, ${createAppFS.toString()}, ${createAppKV.toString()}, ${createAppAI.toString()});</script></body></html>`
}

/** Each mount owns a revocable capability. A sandbox's opaque origin is authenticated by source + instance channel. */
export class AppRuntime {
	readonly frame: HTMLIFrameElement
	readonly ready: Promise<void>
	private destroyed = false
	private settled = false
	private theme: AppTheme
	private errors = 0
	private requestCount = 0
	private requestWindow = Date.now()
	private resolve!: () => void
	private reject!: (error: Error) => void
	private readonly channel = createId('runtime').replaceAll('-', '')
	private readonly win: Window
	private readonly timer: number
	private readonly ai: AppAIBridge
	constructor(
		private readonly container: HTMLElement,
		readonly content: AppContent,
		private readonly host: RuntimeHost,
		title = 'App',
	) {
		const doc = container.ownerDocument
		this.win = doc.defaultView!
		this.frame = doc.win.createEl('iframe')
		this.frame.className = 'ns-app-runtime'
		this.frame.title = title
		this.frame.setAttribute('sandbox', 'allow-scripts')
		this.frame.setAttribute('referrerpolicy', 'no-referrer')
		this.ai = new AppAIBridge(
			host.ai,
			(event) => {
				if (!this.destroyed)
					this.frame.contentWindow?.postMessage(
						{ ...event, channel: this.channel },
						'*',
					)
			},
			this.win,
		)
		this.ready = new Promise((resolve, reject) => {
			this.resolve = resolve
			this.reject = reject
		})
		// Subscribe before srcdoc executes; all asynchronous errors are observed even during teardown.
		void this.ready.catch(() => {})
		this.win.addEventListener('message', this.receive)
		this.theme = readAppTheme(container)
		this.frame.srcdoc = runtimeDocument(this.content, this.channel, this.theme)
		container.append(this.frame)
		this.timer = this.win.setTimeout(
			() =>
				this.fail({
					name: 'TimeoutError',
					source: 'runtime',
					message: 'App startup timed out',
				}),
			8000,
		)
	}
	private fail(input: unknown) {
		if (this.destroyed || this.errors++ >= 10) return
		const parsed = runtimeFailureSchema.safeParse(input)
		const failure: AppRuntimeFailure = parsed.success
			? parsed.data
			: {
					name: 'AppRuntimeError',
					source: 'runtime',
					message: 'App runtime reported an invalid error',
				}
		const message = formatAppRuntimeFailure(failure)
		this.host.log({
			level: 'error',
			source: failure.source ?? 'runtime',
			message: failure.message,
			...(failure.stack ? { stack: failure.stack } : {}),
			...(failure.filename ? { filename: failure.filename } : {}),
			...(failure.line !== undefined ? { line: failure.line } : {}),
			...(failure.column !== undefined ? { column: failure.column } : {}),
		})
		this.host.error(message)
		if (!this.settled) {
			this.settled = true
			this.win.clearTimeout(this.timer)
			this.reject(new Error(message))
		}
	}
	private postTheme() {
		if (this.destroyed) return
		this.frame.contentWindow?.postMessage(
			{ channel: this.channel, event: 'theme', theme: this.theme },
			'*',
		)
	}
	/** Apply host theme changes without reloading App state or its iframe. */
	updateTheme(theme: AppTheme = readAppTheme(this.container)) {
		if (this.destroyed) return
		this.theme = {
			colorScheme: theme.colorScheme,
			properties: { ...theme.properties },
		}
		if (this.settled) this.postTheme()
	}
	private receive = (event: MessageEvent<unknown>) => {
		if (
			this.destroyed ||
			event.source !== this.frame.contentWindow ||
			!event.data ||
			typeof event.data !== 'object'
		)
			return
		const data = event.data as Record<string, unknown>
		if (data.channel !== this.channel) return
		if (data.event === 'log') {
			const parsed = runtimeLogSchema.safeParse(data.log)
			if (parsed.success) this.host.log(parsed.data)
			return
		}
		if (data.event === 'error') {
			this.fail(data.failure)
			return
		}
		if (data.event === 'ready') {
			if (!this.settled) {
				this.settled = true
				this.win.clearTimeout(this.timer)
				this.resolve()
				this.postTheme()
			}
			return
		}
		const parsed = requestSchema.safeParse(data)
		if (!parsed.success) return
		const request = parsed.data
		if (Date.now() - this.requestWindow > 1000) {
			this.requestWindow = Date.now()
			this.requestCount = 0
		}
		const execute = async () => {
			// Control replies settle existing bounded AI runs and must remain usable under load.
			if (
				!['ai.cancel', 'ai.toolResult'].includes(request.method) &&
				++this.requestCount > 60
			)
				throw new Error('App request rate exceeded')
			if (request.method.startsWith('ai.'))
				return this.ai.dispatch(request.method.slice(3), request.args)
			if (request.method.startsWith('fs.')) {
				if (!this.host.fs) throw new Error('Filesystem unavailable')
				return this.host.fs(request.method.slice(3), request.args)
			}
			if (request.method.startsWith('kv.')) {
				return dispatchAppKV(
					this.host,
					request.method.slice(3),
					request.args,
					() => {
						if (this.destroyed) throw new Error('App closed')
					},
				)
			}
			throw new Error('Unknown App operation')
		}
		void execute().then(
			(value) => {
				if (!this.destroyed)
					this.frame.contentWindow?.postMessage(
						{ channel: this.channel, id: request.id, value },
						'*',
					)
			},
			(error: unknown) => {
				if (!this.destroyed)
					this.frame.contentWindow?.postMessage(
						{
							channel: this.channel,
							id: request.id,
							error: error instanceof Error ? error.message : String(error),
							...(error instanceof AppAIError ? { code: error.code } : {}),
						},
						'*',
					)
			},
		)
	}
	destroy() {
		if (this.destroyed) return
		this.destroyed = true
		this.ai.close()
		this.win.clearTimeout(this.timer)
		this.win.removeEventListener('message', this.receive)
		this.frame.remove()
		if (!this.settled) {
			this.settled = true
			this.reject(new Error('App closed'))
		}
	}
}
