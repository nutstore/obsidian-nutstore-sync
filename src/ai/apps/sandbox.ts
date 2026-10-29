import type { AppFS, createAppFS } from './capabilities/fs'
import type { AppKVAPI, createAppKV } from './capabilities/kv'
import type { createAppAI } from './capabilities/ai'
import type { AppAIAPI, AppAIEvent } from './ai/contract'
import type { AppTheme } from './theme'

export interface AppRuntimeAPI {
	fs: AppFS
	kv: AppKVAPI
	ai: AppAIAPI
}

/**
 * This module executes in the iframe, not in Obsidian. Runtime dependencies
 * must be supplied as serialized arguments; host imports and polyfills are
 * unavailable. Keep imports type-only so the boundary is visible in source.
 */
/** This function is serialized into srcdoc. Keep it self-contained and browser-only. */
export function bootstrap(
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
	const maxPendingRequests = 512
	let nextId = 0
	const pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void }
	>()
	const send = (message: Record<string, unknown>) =>
		parent.postMessage({ ...message, channel }, '*')
	const rpc = (method: string, ...args: unknown[]): Promise<unknown> =>
		new Promise((resolve, reject) => {
			if (pending.size >= maxPendingRequests) {
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
			const properties = theme.properties as Record<string, unknown>
			for (const key of Object.keys(properties)) {
				const property = properties[key]
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
	// The host document owns the stylesheet slot; App CSS only supplies its text.
	const style = document.querySelector<HTMLStyleElement>(
		'head > style[data-app-styles]',
	)
	if (!style) throw new Error('App document is missing its stylesheet slot')
	style.textContent = payload.css
	// Parse an inert document before adopting any nodes into the live frame.
	// The authored body is data; only the separately nonce-bearing script below
	// may start the App. Template contents form separate trees and must follow
	// exactly the same markup policy before an App clones them into the body.
	const parsed = new DOMParser().parseFromString(
		`<!doctype html><body>${payload.html}</body>`,
		'text/html',
	)
	const sanitize = (root: ParentNode) => {
		for (const el of Array.from(root.querySelectorAll('*'))) {
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
					['href', 'xlink:href', 'src', 'poster'].includes(attr.name) &&
					!/^#|^data:(?:image|audio|video|font)\//.test(attr.value)
				)
					el.removeAttribute(attr.name)
			}
			if (el.localName === 'template' && 'content' in el) {
				sanitize((el as HTMLTemplateElement).content)
			}
		}
	}
	sanitize(parsed)
	document.body.replaceChildren(...Array.from(parsed.body.childNodes))
	const script = document.createElement('script')
	script.nonce = payload.nonce
	script.textContent = `(async () => {\n${payload.javascript}\n})().then(window.__appStarted).catch(window.__appFailed);\n//# sourceURL=nutstore-app.js`
	document.body.append(script)
}
