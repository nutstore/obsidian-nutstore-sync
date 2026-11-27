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
		html: string
		css: string
		theme: AppTheme
		fsMethods: string[]
	},
	createFS: typeof createAppFS,
	createKV: typeof createAppKV,
	createAI: typeof createAppAI,
) {
	const channel = payload.channel
	const maxPendingRequests = 512
	const maxBreadcrumbs = 20
	const maxCauseDepth = 5
	let nextId = 0
	let currentColorScheme: 'light' | 'dark' | undefined
	const pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void }
	>()
	const breadcrumbs: Array<{
		timestamp: number
		category: 'ui' | 'console' | 'rpc' | 'lifecycle'
		level?: 'debug' | 'info' | 'log' | 'warn' | 'error'
		message: string
		data?: Record<string, unknown>
	}> = []

	const truncate = (text: string, max: number) =>
		text.length <= max ? text : `${text.slice(0, max - 1)}…`

	const addBreadcrumb = (
		category: 'ui' | 'console' | 'rpc' | 'lifecycle',
		message: string,
		level?: 'debug' | 'info' | 'log' | 'warn' | 'error',
		data?: Record<string, unknown>,
	) => {
		breadcrumbs.push({
			timestamp: Date.now(),
			category,
			...(level ? { level } : {}),
			message: truncate(message || '(empty)', 240),
			...(data ? { data } : {}),
		})
		if (breadcrumbs.length > maxBreadcrumbs) {
			breadcrumbs.splice(0, breadcrumbs.length - maxBreadcrumbs)
		}
	}

	const snapshotBreadcrumbs = () =>
		breadcrumbs.length ? breadcrumbs.slice() : undefined

	const describeElement = (node: unknown): string => {
		if (!node || typeof node !== 'object') return ''
		const el = node as Element
		if (el.nodeType !== 1 || !el.localName) return ''
		let label = el.localName
		if (el.id) label += `#${truncate(el.id, 40)}`
		if (typeof el.className === 'string' && el.className.trim()) {
			const classes = el.className.trim().split(/\s+/).slice(0, 3)
			if (classes.length) label += `.${classes.join('.')}`
		}
		const typeAttr = el.getAttribute('type')
		if (typeAttr) label += `[type="${truncate(typeAttr, 24)}"]`
		const nameAttr = el.getAttribute('name')
		if (nameAttr) label += `[name="${truncate(nameAttr, 32)}"]`
		const ariaLabel = el.getAttribute('aria-label')
		if (ariaLabel) {
			label += ` ("${truncate(ariaLabel.trim(), 40)}")`
		} else if (
			el.localName === 'button' ||
			el.localName === 'a' ||
			el.localName === 'label'
		) {
			const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
			if (text) label += ` ("${truncate(text, 40)}")`
		}
		return label
	}

	const summarizeUrl = (raw: string) => {
		if (!raw) return ''
		if (raw.indexOf('data:') === 0 && raw.length > 96) {
			const comma = raw.indexOf(',')
			const prefix =
				comma > 0 ? raw.slice(0, Math.min(comma + 1, 64)) : raw.slice(0, 64)
			return `${prefix}…(${raw.length} chars)`
		}
		return truncate(raw, 200)
	}

	const currentContext = (extra?: Record<string, unknown>) => {
		const ctx: Record<string, unknown> = {
			viewport: { width: window.innerWidth, height: window.innerHeight },
		}
		if (currentColorScheme) ctx.colorScheme = currentColorScheme
		if (extra) {
			for (const key of Object.keys(extra)) ctx[key] = extra[key]
		}
		return ctx
	}

	const summarizeRpcArgs = (method: string, args: unknown[]) => {
		if (method.indexOf('fs.') === 0) {
			const paths: string[] = []
			for (let i = 0; i < args.length && paths.length < 2; i++) {
				if (typeof args[i] === 'string')
					paths.push(truncate(args[i] as string, 100))
			}
			return paths.join(' -> ')
		}
		if (method.indexOf('kv.') === 0) {
			if (method === 'kv.get' && typeof args[0] === 'string')
				return truncate(args[0], 80)
			if (method === 'kv.transact' && Array.isArray(args[0])) {
				const keys: string[] = []
				for (let i = 0; i < args[0].length && i < 4; i++) {
					const item = args[0][i] as { key?: unknown } | null
					if (item && typeof item.key === 'string') keys.push(item.key)
				}
				return `keys=[${keys.join(', ')}]`
			}
		}
		return ''
	}

	const send = (message: Record<string, unknown>) =>
		parent.postMessage({ ...message, channel }, '*')

	const rpc = (method: string, ...args: unknown[]): Promise<unknown> =>
		new Promise((resolve, reject) => {
			if (pending.size >= maxPendingRequests) {
				const err = new Error('Too many pending App requests')
				addBreadcrumb('rpc', `${method} failed: ${err.message}`, 'error')
				reject(err)
				return
			}
			const id = ++nextId
			const startedAt = Date.now()
			const argsSummary = summarizeRpcArgs(method, args)
			const trackBreadcrumb = method !== 'ai.cancel'
			pending.set(id, {
				resolve(value) {
					if (trackBreadcrumb) {
						addBreadcrumb(
							'rpc',
							argsSummary ? `${method} ${argsSummary}` : method,
							'info',
							{ durationMs: Date.now() - startedAt },
						)
					}
					resolve(value)
				},
				reject(error) {
					if (trackBreadcrumb) {
						const detail = error && error.message ? error.message : 'failed'
						addBreadcrumb(
							'rpc',
							`${method}${argsSummary ? ` ${argsSummary}` : ''} failed: ${detail}`,
							'error',
							{ durationMs: Date.now() - startedAt },
						)
					}
					reject(error)
				},
			})
			send({ id, method, args })
		})

	const safeSerialize = (
		value: unknown,
		seen: unknown[],
		depth: number,
	): unknown => {
		if (value === null || value === undefined) return value
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		)
			return value
		if (typeof value === 'bigint') return `${value}n`
		if (typeof value === 'symbol') return value.toString()
		if (typeof value === 'function')
			return `[Function ${value.name || 'anonymous'}]`
		if (seen.indexOf(value) >= 0) return '[Circular]'
		if (depth >= 4) return Array.isArray(value) ? '[Array]' : '[Object]'
		const elementDesc = describeElement(value)
		if (elementDesc) return `<${elementDesc}>`
		seen.push(value)
		try {
			if (Array.isArray(value)) {
				const out: unknown[] = []
				const limit = Math.min(value.length, 50)
				for (let i = 0; i < limit; i++) {
					out.push(safeSerialize(value[i], seen, depth + 1))
				}
				if (value.length > limit) out.push(`…(${value.length - limit} more)`)
				return out
			}
			const record = value as Record<string, unknown>
			if (typeof record.stack === 'string') return record.stack
			if (
				typeof record.message === 'string' &&
				typeof record.name === 'string'
			) {
				return `${record.name}: ${record.message}`
			}
			const keys = Object.keys(record)
			if (!keys.length) return Object.prototype.toString.call(value)
			const obj: Record<string, unknown> = {}
			const limit = Math.min(keys.length, 50)
			for (let i = 0; i < limit; i++) {
				const k = keys[i]
				try {
					obj[k] = safeSerialize(record[k], seen, depth + 1)
				} catch {
					obj[k] = '[Unreadable]'
				}
			}
			return obj
		} finally {
			seen.pop()
		}
	}

	const stringifyValue = (value: unknown): string => {
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
			try {
				const fallback = JSON.stringify(safeSerialize(value, [], 0))
				if (fallback !== undefined) return fallback
			} catch {
				// Fall through to the browser's best-effort string form.
			}
		}
		return Object.prototype.toString.call(value)
	}

	const readErrorCode = (value: unknown): string | undefined => {
		if (!value || typeof value !== 'object') return undefined
		const code = (value as { code?: unknown }).code
		if (typeof code === 'string' && code) return code
		if (typeof code === 'number') return String(code)
		return undefined
	}

	const extractCauses = (value: unknown) => {
		const causes: Array<{
			name?: string
			code?: string
			message: string
			stack?: string
		}> = []
		const seen: unknown[] = []
		let current: unknown = value
		for (let depth = 0; depth < maxCauseDepth; depth++) {
			if (!current || typeof current !== 'object') break
			const next = (current as { cause?: unknown }).cause
			if (next === undefined || seen.indexOf(next) >= 0) break
			seen.push(next)
			const rec =
				next && typeof next === 'object'
					? (next as { name?: unknown; message?: unknown; stack?: unknown })
					: undefined
			const code = readErrorCode(next)
			const message =
				typeof rec?.message === 'string' && rec.message
					? rec.message
					: stringifyValue(next)
			causes.push({
				...(typeof rec?.name === 'string' && rec.name
					? { name: rec.name }
					: {}),
				...(code ? { code } : {}),
				message: message || 'Error',
				...(typeof rec?.stack === 'string' && rec.stack
					? { stack: rec.stack }
					: {}),
			})
			current = next
		}
		return causes
	}

	const failureFor = (
		value: unknown,
		source: 'startup' | 'uncaught' | 'unhandled-rejection' | 'rpc',
		location?: { filename?: string; line?: number; column?: number },
		extraContext?: Record<string, unknown>,
	) => {
		const record =
			value && typeof value === 'object'
				? (value as { name?: unknown; message?: unknown; stack?: unknown })
				: undefined
		const message =
			typeof record?.message === 'string' && record.message
				? record.message
				: stringifyValue(value)
		const code = readErrorCode(value)
		const causes = extractCauses(value)
		const trail = snapshotBreadcrumbs()
		return {
			message: message || 'App runtime error',
			...(typeof record?.name === 'string' && record.name
				? { name: record.name }
				: {}),
			...(code ? { code } : {}),
			...(typeof record?.stack === 'string' && record.stack
				? { stack: record.stack }
				: {}),
			source,
			...(location?.filename ? { filename: location.filename } : {}),
			...(location?.line !== undefined ? { line: location.line } : {}),
			...(location?.column !== undefined ? { column: location.column } : {}),
			...(causes.length ? { causes } : {}),
			...(trail ? { breadcrumbs: trail } : {}),
			context: currentContext(extraContext),
		}
	}

	const ai = createAI(rpc, ({ toolName, toolCallId, error: toolError }) => {
		const detail = failureFor(toolError, 'rpc', undefined, {
			rpc: { method: 'ai.tool', toolName, detail: toolCallId },
		})
		send({
			event: 'log',
			log: {
				level: 'error',
				...detail,
			},
		})
	})

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
		if (theme.colorScheme === 'light' || theme.colorScheme === 'dark') {
			currentColorScheme = theme.colorScheme
			document.documentElement.style.setProperty(
				'color-scheme',
				theme.colorScheme,
			)
		}
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

	const consoleTarget = console as unknown as Record<
		string,
		(...args: unknown[]) => void
	>
	for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) {
		const original = consoleTarget[level].bind(console)
		consoleTarget[level] = (...args: unknown[]) => {
			original(...args)
			const error = args.find(
				(value) =>
					value &&
					typeof value === 'object' &&
					(typeof (value as { stack?: unknown }).stack === 'string' ||
						(typeof (value as { name?: unknown }).name === 'string' &&
							typeof (value as { message?: unknown }).message === 'string')),
			) as
				| { name?: string; stack?: string; code?: unknown; cause?: unknown }
				| undefined
			const message = args.map(stringifyValue).join(' ') || '(empty log entry)'
			const code = error ? readErrorCode(error) : undefined
			const causes = error ? extractCauses(error) : []
			const trail = level === 'error' ? snapshotBreadcrumbs() : undefined
			addBreadcrumb('console', message, level)
			send({
				event: 'log',
				log: {
					level,
					source: 'console',
					message,
					...(typeof error?.name === 'string' && error.name
						? { name: error.name }
						: {}),
					...(code ? { code } : {}),
					...(typeof error?.stack === 'string' && error.stack
						? { stack: error.stack }
						: {}),
					...(causes.length ? { causes } : {}),
					...(trail ? { breadcrumbs: trail } : {}),
					...(level === 'error' ? { context: currentContext() } : {}),
				},
			})
		}
	}

	// Capture-phase UI breadcrumbs so error snapshots show the exact user actions leading up to failure.
	for (const eventName of ['click', 'submit', 'change'] as const) {
		document.addEventListener(
			eventName,
			(event) => {
				const desc = describeElement(event.target)
				if (!desc) return
				addBreadcrumb('ui', `${eventName} ${desc}`)
			},
			true,
		)
	}

	// Capture-phase error listener catches both uncaught JS errors and non-bubbling resource load failures.
	window.addEventListener(
		'error',
		(event) => {
			const target = event.target
			if (
				target &&
				target !== window &&
				(target as Element).nodeType === 1 &&
				!event.error &&
				!event.message
			) {
				const el = target as Element
				const tagName = el.localName || 'element'
				const selector = describeElement(el)
				const rawUrl =
					el.getAttribute('src') ||
					el.getAttribute('href') ||
					el.getAttribute('poster') ||
					''
				const url = summarizeUrl(rawUrl)
				const trail = snapshotBreadcrumbs()
				send({
					event: 'error',
					failure: {
						name: 'ResourceError',
						source: 'resource',
						message: `Failed to load <${tagName}>${url ? `: ${url}` : ''}`,
						...(trail ? { breadcrumbs: trail } : {}),
						context: currentContext({
							resource: {
								tagName,
								...(selector ? { selector } : {}),
								...(url ? { url } : {}),
							},
						}),
					},
				})
				return
			}
			send({
				event: 'error',
				failure: failureFor(event.error ?? event.message, 'uncaught', {
					filename: event.filename,
					line: event.lineno,
					column: event.colno,
				}),
			})
		},
		true,
	)

	window.addEventListener('unhandledrejection', (event) => {
		send({
			event: 'error',
			failure: failureFor(event.reason, 'unhandled-rejection'),
		})
	})

	window.addEventListener('securitypolicyviolation', (event) => {
		const directive =
			event.effectiveDirective || event.violatedDirective || 'policy'
		const blockedURI = summarizeUrl(event.blockedURI || '')
		const sourceFile = event.sourceFile || undefined
		const line =
			typeof event.lineNumber === 'number' && event.lineNumber > 0
				? event.lineNumber
				: undefined
		const column =
			typeof event.columnNumber === 'number' && event.columnNumber > 0
				? event.columnNumber
				: undefined
		const trail = snapshotBreadcrumbs()
		send({
			event: 'error',
			failure: {
				name: 'SecurityPolicyViolation',
				source: 'csp',
				message: `CSP violation (${directive}): blocked ${blockedURI || 'inline'}`,
				...(sourceFile ? { filename: sourceFile } : {}),
				...(line !== undefined ? { line } : {}),
				...(column !== undefined ? { column } : {}),
				...(trail ? { breadcrumbs: trail } : {}),
				context: currentContext({
					csp: {
						...(event.violatedDirective
							? { violatedDirective: event.violatedDirective }
							: {}),
						...(event.effectiveDirective
							? { effectiveDirective: event.effectiveDirective }
							: {}),
						...(blockedURI ? { blockedURI } : {}),
						...(event.disposition ? { disposition: event.disposition } : {}),
						...(sourceFile ? { sourceFile } : {}),
						...(line !== undefined ? { line } : {}),
						...(column !== undefined ? { column } : {}),
						...(event.sample ? { sample: truncate(event.sample, 160) } : {}),
					},
				}),
			},
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
		value: () => {
			addBreadcrumb('lifecycle', 'App started')
			send({ event: 'ready' })
		},
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
	// The authored body is data; only the separately nonce-bearing script
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
}
