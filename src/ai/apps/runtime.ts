import { appFSMethods, createAppFS, type AppFS } from './capabilities/fs'
import {
	createAppKV,
	dispatchAppKV,
	type AppKVAPI,
	type AppKVHost,
} from './capabilities/kv'
import { z } from 'zod/mini'
import createId from '~/utils/create-id'
import type { AppContent } from './source'
import { emptyAppTheme, readAppTheme, type AppTheme } from './theme'
import type { AppLogEvent } from './logs'
import { createAppAI } from './capabilities/ai'
import { AppAIBridge } from './ai/bridge'
import {
	AppAIError,
	type AppAIAPI,
	type AppAIEvent,
	type AppAIHost,
} from './ai/contract'

export interface AppRuntimeAPI {
	fs: AppFS
	kv: AppKVAPI
	ai: AppAIAPI
}
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

/** This function is serialized into srcdoc. Keep it self-contained and browser-only. */
/* eslint-disable obsidianmd/prefer-create-el -- Serialized sandbox code runs in a standard browser document without Obsidian DOM extensions. */
function bootstrap(
	payload: {
		channel: string
		nonce: string
		html: string
		css: string
		javascript: string
		theme: AppTheme
		fsMethods: string[]
	},
	createFS: typeof createAppFS,
	createKV: typeof createAppKV,
	createAI: typeof createAppAI,
) {
	const channel = payload.channel
	let nextId = 0
	const pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void }
	>()
	const send = (message: Record<string, unknown>) =>
		parent.postMessage({ ...message, channel }, '*')
	const rpc = (method: string, ...args: unknown[]): Promise<unknown> =>
		new Promise((resolve, reject) => {
			if (pending.size >= 100) {
				reject(new Error('Too many pending App requests'))
				return
			}
			const id = ++nextId
			pending.set(id, { resolve, reject })
			send({ id, method, args })
		})
	const ai = createAI(rpc)
	let themeKeys: string[] = []
	const applyTheme = (value: unknown) => {
		if (!value || typeof value !== 'object') return
		const theme = value as {
			colorScheme?: unknown
			properties?: unknown
		}
		if (theme.properties && typeof theme.properties === 'object') {
			for (const key of themeKeys)
				document.documentElement.style.removeProperty(key)
			themeKeys = []
			for (const [key, property] of Object.entries(theme.properties)) {
				if (!key.startsWith('--') || typeof property !== 'string') continue
				document.documentElement.style.setProperty(key, property)
				themeKeys.push(key)
			}
		}
		if (theme.colorScheme === 'light' || theme.colorScheme === 'dark')
			document.documentElement.style.setProperty(
				'color-scheme',
				theme.colorScheme,
			)
	}
	window.addEventListener('message', (event: MessageEvent<unknown>) => {
		if (
			event.source !== parent ||
			!event.data ||
			typeof event.data !== 'object'
		)
			return
		const data = event.data as {
			channel?: unknown
			id?: unknown
			error?: unknown
			value?: unknown
			event?: unknown
			theme?: unknown
			code?: unknown
		}
		if (data.channel !== channel) return
		if (data.event === 'ai') {
			ai.receive(event.data as AppAIEvent)
			return
		}
		if (data.event === 'theme') {
			applyTheme(data.theme)
			return
		}
		if (typeof data.id !== 'number') return
		const reply = pending.get(data.id)
		if (!reply) return
		pending.delete(data.id)
		if (typeof data.error === 'string')
			reply.reject(
				Object.assign(new Error(data.error), {
					...(typeof data.code === 'string' ? { code: data.code } : {}),
					...(data.code === 'CANCELLED' ? { name: 'AbortError' } : {}),
				}),
			)
		else reply.resolve(data.value)
	})
	const truncate = (value: string, maximum: number) =>
		value.length > maximum ? `${value.slice(0, maximum)}...` : value
	const stringifyValue = (value: unknown) => {
		if (typeof value === 'string') return value
		if (typeof value === 'undefined') return 'undefined'
		if (typeof value === 'bigint') return `${value}n`
		if (typeof value === 'symbol') return value.toString()
		if (typeof value === 'function')
			return `[Function ${value.name || 'anonymous'}]`
		if (value && typeof value === 'object') {
			const stack = (value as { stack?: unknown }).stack
			const message = (value as { message?: unknown }).message
			if (typeof stack === 'string') return stack
			if (typeof message === 'string') return message
		}
		try {
			const json = JSON.stringify(value)
			if (json !== undefined) return json
		} catch {
			// Fall through to the browser's best-effort string form.
		}
		return Object.prototype.toString.call(value)
	}
	const failureFor = (
		value: unknown,
		source: 'startup' | 'uncaught' | 'unhandled-rejection',
		location?: { filename?: string; line?: number; column?: number },
	) => {
		const record =
			value && typeof value === 'object'
				? (value as { name?: unknown; message?: unknown; stack?: unknown })
				: undefined
		const message =
			typeof record?.message === 'string' && record.message
				? record.message
				: stringifyValue(value)
		return {
			message: truncate(message || 'App runtime error', 4_000),
			...(typeof record?.name === 'string' && record.name
				? { name: truncate(record.name, 200) }
				: {}),
			...(typeof record?.stack === 'string' && record.stack
				? { stack: truncate(record.stack, 12_000) }
				: {}),
			source,
			...(location?.filename
				? { filename: truncate(location.filename, 1_000) }
				: {}),
			...(location?.line !== undefined ? { line: location.line } : {}),
			...(location?.column !== undefined ? { column: location.column } : {}),
		}
	}
	let logWindow = Date.now()
	let logCount = 0
	const canEmitLog = () => {
		const now = Date.now()
		if (now - logWindow >= 1_000) {
			logWindow = now
			logCount = 0
		}
		return ++logCount <= 100
	}
	const consoleTarget = console as unknown as Record<
		string,
		(...args: unknown[]) => void
	>
	for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) {
		const original = consoleTarget[level].bind(console)
		consoleTarget[level] = (...args: unknown[]) => {
			original(...args)
			if (!canEmitLog()) return
			const error = args.find(
				(value) =>
					value &&
					typeof value === 'object' &&
					typeof (value as { stack?: unknown }).stack === 'string',
			) as { stack?: string } | undefined
			send({
				event: 'log',
				log: {
					level,
					source: 'console',
					message: truncate(
						args.map(stringifyValue).join(' ') || '(empty log entry)',
						4_000,
					),
					...(error?.stack ? { stack: truncate(error.stack, 12_000) } : {}),
				},
			})
		}
	}
	window.addEventListener('error', (event) => {
		send({
			event: 'error',
			failure: failureFor(event.error ?? event.message, 'uncaught', {
				filename: event.filename,
				line: event.lineno,
				column: event.colno,
			}),
		})
	})
	window.addEventListener('unhandledrejection', (event) => {
		send({
			event: 'error',
			failure: failureFor(event.reason, 'unhandled-rejection'),
		})
	})
	const api: AppRuntimeAPI = {
		fs: createFS(rpc, payload.fsMethods),
		kv: createKV(rpc),
		ai: ai.api,
	}
	window.addEventListener('pagehide', () => ai.close(), { once: true })

	Object.defineProperty(window, 'app', {
		value: Object.freeze(api),
		writable: false,
	})
	Object.defineProperty(window, '__appStarted', {
		value: () => send({ event: 'ready' }),
		writable: false,
	})
	Object.defineProperty(window, '__appFailed', {
		value: (error: unknown) =>
			send({ event: 'error', failure: failureFor(error, 'startup') }),
		writable: false,
	})
	applyTheme(payload.theme)
	// eslint-disable-next-line obsidianmd/no-forbidden-elements -- The sandbox owns its generated stylesheet.
	const style = document.createElement('style')
	style.textContent = payload.css
	document.head.append(style)
	const template = document.createElement('template')
	// eslint-disable-next-line no-unsanitized/property, @microsoft/sdl/no-inner-html -- Model markup is parsed only inside the opaque-origin sandbox, never the Obsidian host DOM.
	template.innerHTML = payload.html
	// The host owns scripts, CSP and document structure. URL-bearing markup cannot navigate or embed another document.
	for (const el of Array.from(template.content.querySelectorAll('*'))) {
		if (
			[
				'script',
				'iframe',
				'object',
				'embed',
				'base',
				'meta',
				'link',
				'style',
			].includes(el.localName)
		) {
			el.remove()
			continue
		}
		for (const attr of Array.from(el.attributes)) {
			if (
				/^on/i.test(attr.name) ||
				[
					'srcdoc',
					'action',
					'formaction',
					'target',
					'nonce',
					'srcset',
					'ping',
				].includes(attr.name)
			)
				el.removeAttribute(attr.name)
			if (
				['href', 'xlink:href', 'src'].includes(attr.name) &&
				!/^#|^data:(?:image|audio|video|font)\//.test(attr.value)
			)
				el.removeAttribute(attr.name)
		}
	}
	document.body.replaceChildren(template.content)
	const script = document.createElement('script')
	script.nonce = payload.nonce
	script.textContent = `(async () => {\n${payload.javascript}\n})().then(window.__appStarted).catch(window.__appFailed);\n//# sourceURL=nutstore-app.js`
	document.body.append(script)
}
/* eslint-enable obsidianmd/prefer-create-el -- Host code below runs with Obsidian DOM extensions. */

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
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html{color-scheme:light dark}body{margin:0;padding:16px;color:var(--text-normal,CanvasText);background:var(--background-primary,Canvas);font-family:var(--font-interface,var(--font-text,system-ui,sans-serif));font-size:var(--font-ui-medium,14px);line-height:1.5}*{box-sizing:border-box}button,input,textarea,select{font:inherit;color:var(--text-normal,CanvasText)}button{background:var(--interactive-normal,var(--background-secondary,ButtonFace));border:1px solid var(--background-modifier-border,ButtonBorder);border-radius:var(--button-radius,var(--radius-s,6px));padding:6px 12px}button:hover{background:var(--interactive-hover,var(--background-modifier-hover,ButtonFace))}input,textarea,select{background:var(--background-modifier-form-field,var(--background-primary,Field));border:1px solid var(--background-modifier-border,ButtonBorder);border-radius:var(--input-radius,var(--radius-s,6px));padding:6px 8px}a{color:var(--link-color,var(--text-accent,LinkText))}a:hover{color:var(--link-color-hover,var(--text-accent-hover,LinkText))}::selection{background:var(--text-selection,Highlight)}img,canvas,svg{max-width:100%}</style></head><body><script nonce="${channel}">(${bootstrap.toString()})(${payload}, ${createAppFS.toString()}, ${createAppKV.toString()}, ${createAppAI.toString()});</script></body></html>`
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
