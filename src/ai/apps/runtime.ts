import { appFSMethods, createAppFS } from './capabilities/fs'
import { createAppKV, dispatchAppKV, type AppKVHost } from './capabilities/kv'
import * as z from 'zod/mini'
import createId from '~/utils/create-id'
import { getWebviewRuntimeInfo } from '~/utils/webview-runtime-info'
import type { AppContent } from './source'
import { emptyAppTheme, readAppTheme, type AppTheme } from './theme'
import type { AppLogEvent } from './logs'
import { createAppAI } from './capabilities/ai'
import { bootstrap } from './sandbox'
import { AppAIBridge } from './ai/bridge'
import {
	AppAIError,
	type AppAIDiagnosticDetail,
	type AppAIHost,
} from './ai/contract'
import {
	APP_BREADCRUMB_CATEGORIES,
	APP_LOG_LEVELS,
	APP_LOG_SOURCES,
	APP_RUNTIME_SCRIPT_URL,
	AppErrorDeduplicator,
	AppSourceMapper,
	summarizeRPCArgs,
	type AppDiagnosticContext,
	type AppDiagnosticPhase,
	type AppErrorCause,
	type AppBreadcrumb,
} from './diagnostics'

const requestSchema = z.object({
	channel: z.string(),
	id: z.number().check(z.int(), z.minimum(1)),
	method: z.string(),
	args: z.array(z.unknown()).check(z.maxLength(3)),
})
export interface RuntimeHost extends AppKVHost {
	fs?: (method: string, args: unknown[]) => Promise<unknown>
	ai?: AppAIHost
	phase?: AppDiagnosticPhase
	log(event: AppLogEvent): void
	error(message: string): void
}

export interface AppRuntimeFailure {
	message: string
	name?: string
	code?: string
	source?:
		| 'startup'
		| 'uncaught'
		| 'unhandled-rejection'
		| 'csp'
		| 'resource'
		| 'rpc'
		| 'runtime'
	stack?: string
	filename?: string
	line?: number
	column?: number
	causes?: AppErrorCause[]
	breadcrumbs?: AppBreadcrumb[]
	context?: AppDiagnosticContext
}

const errorCauseSchema = z.object({
	name: z.optional(z.string()),
	code: z.optional(z.string()),
	message: z.string().check(z.minLength(1)),
	stack: z.optional(z.string()),
})

const breadcrumbSchema = z.object({
	timestamp: z.number(),
	category: z.enum(APP_BREADCRUMB_CATEGORIES),
	level: z.optional(z.enum(APP_LOG_LEVELS)),
	message: z.string().check(z.minLength(1)),
	data: z.optional(z.record(z.string(), z.unknown())),
})

const diagnosticContextSchema = z.object({
	viewport: z.optional(
		z.object({
			width: z.number(),
			height: z.number(),
		}),
	),
	colorScheme: z.optional(z.enum(['light', 'dark'])),
	webview: z.optional(z.string()),
	csp: z.optional(
		z.object({
			violatedDirective: z.optional(z.string()),
			effectiveDirective: z.optional(z.string()),
			blockedURI: z.optional(z.string()),
			disposition: z.optional(z.string()),
			sourceFile: z.optional(z.string()),
			line: z.optional(z.number().check(z.int(), z.minimum(0))),
			column: z.optional(z.number().check(z.int(), z.minimum(0))),
			sample: z.optional(z.string()),
		}),
	),
	rpc: z.optional(
		z.object({
			method: z.string(),
			argsSummary: z.optional(z.string()),
			durationMs: z.optional(z.number()),
			code: z.optional(z.string()),
			detail: z.optional(z.string()),
			toolName: z.optional(z.string()),
		}),
	),
	resource: z.optional(
		z.object({
			tagName: z.string(),
			selector: z.optional(z.string()),
			url: z.optional(z.string()),
		}),
	),
})

const runtimeLogSchema = z.object({
	level: z.enum(APP_LOG_LEVELS),
	source: z.enum(APP_LOG_SOURCES),
	message: z.string().check(z.minLength(1)),
	name: z.optional(z.string()),
	code: z.optional(z.string()),
	stack: z.optional(z.string()),
	filename: z.optional(z.string()),
	line: z.optional(z.number().check(z.int(), z.minimum(0))),
	column: z.optional(z.number().check(z.int(), z.minimum(0))),
	causes: z.optional(z.array(errorCauseSchema)),
	breadcrumbs: z.optional(z.array(breadcrumbSchema)),
	context: z.optional(diagnosticContextSchema),
})

const runtimeFailureSchema = z.object({
	message: z.string().check(z.minLength(1)),
	name: z.optional(z.string()),
	code: z.optional(z.string()),
	source: z.optional(
		z.enum([
			'startup',
			'uncaught',
			'unhandled-rejection',
			'csp',
			'resource',
			'rpc',
			'runtime',
		]),
	),
	stack: z.optional(z.string()),
	filename: z.optional(z.string()),
	line: z.optional(z.number().check(z.int(), z.minimum(0))),
	column: z.optional(z.number().check(z.int(), z.minimum(0))),
	causes: z.optional(z.array(errorCauseSchema)),
	breadcrumbs: z.optional(z.array(breadcrumbSchema)),
	context: z.optional(diagnosticContextSchema),
})

export function formatAppRuntimeFailure(failure: AppRuntimeFailure) {
	const location = failure.filename
		? ` (${failure.filename}:${failure.line ?? 1}:${failure.column ?? 1})`
		: ''
	const header = `${failure.name ?? 'Error'}: ${failure.message}${location}`
	const stack = failure.stack?.trim()
	if (!stack) return header
	if (stack.includes(failure.message)) {
		return location && !stack.includes(failure.filename!)
			? `${header}\n${stack}`
			: stack
	}
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
		html: content.html,
		css: content.css,
		theme,
		fsMethods: appFSMethods,
	}).replace(/</g, '\\u003c')
	const appScript = `(async () => {\n${content.javascript}\n})().then(window.__appStarted).catch(window.__appFailed);\n//# sourceURL=${APP_RUNTIME_SCRIPT_URL}`
	// Encode the source as data so HTML parsing cannot change its JavaScript semantics.
	const encodedScript = JSON.stringify(appScript).replace(/</g, '\\u003c')
	const policy = `default-src 'none'; script-src 'nonce-${channel}'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html{color-scheme:light dark}body{margin:0;padding:16px;color:var(--text-normal,CanvasText);background:var(--background-primary,Canvas);font-family:var(--font-interface,var(--font-text,system-ui,sans-serif));font-size:var(--font-ui-medium,14px);line-height:1.5}*{box-sizing:border-box}button,input,textarea,select{font:inherit;color:var(--text-normal,CanvasText)}button{background:var(--interactive-normal,var(--background-secondary,ButtonFace));border:1px solid var(--background-modifier-border,ButtonBorder);border-radius:var(--button-radius,var(--radius-s,6px));padding:6px 12px}button:hover{background:var(--interactive-hover,var(--background-modifier-hover,ButtonFace))}input,textarea,select{background:var(--background-modifier-form-field,var(--background-primary,Field));border:1px solid var(--background-modifier-border,ButtonBorder);border-radius:var(--input-radius,var(--radius-s,6px));padding:6px 8px}a{color:var(--link-color,var(--text-accent,LinkText))}a:hover{color:var(--link-color-hover,var(--text-accent-hover,LinkText))}::selection{background:var(--text-selection,Highlight)}img,canvas,svg{max-width:100%}</style><style data-app-styles></style></head><body><script nonce="${channel}">(${bootstrap.toString()})(${payload}, ${createAppFS.toString()}, ${createAppKV.toString()}, ${createAppAI.toString()});</script><script nonce="${channel}">{const script=document.createElement('script');script.nonce='${channel}';script.textContent=${encodedScript};document.currentScript.remove();document.body.appendChild(script)}</script></body></html>`
}

/** Each mount owns a revocable capability. A sandbox's opaque origin is authenticated by source + instance channel. */
export class AppRuntime {
	readonly frame: HTMLIFrameElement
	readonly ready: Promise<void>
	readonly sessionId = createId('session')
	private destroyed = false
	private settled = false
	private theme: AppTheme
	private resolve!: () => void
	private reject!: (error: Error) => void
	private readonly channel = createId('runtime').replaceAll('-', '')
	private readonly win: Window
	private readonly timer: number
	private readonly ai: AppAIBridge
	private readonly mapper: AppSourceMapper
	private readonly dedup: AppErrorDeduplicator
	private readonly webview?: string
	private readonly aiDiagnostics = new Map<number, AppAIDiagnosticDetail>()

	constructor(
		private readonly container: HTMLElement,
		readonly content: AppContent,
		private readonly host: RuntimeHost,
		title = 'App',
	) {
		const doc = container.ownerDocument
		this.win = doc.defaultView!
		this.mapper = new AppSourceMapper(content)
		this.webview =
			typeof navigator !== 'undefined'
				? (getWebviewRuntimeInfo().runtime ?? undefined)
				: undefined
		this.dedup = new AppErrorDeduplicator((summary) => {
			this.host.log(summary)
		}, this.win)
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
			(detail) => {
				if (detail.runId !== undefined) {
					this.aiDiagnostics.set(detail.runId, detail)
				}
				// Non-fatal tool-argument validation errors may be recovered by the model; log immediately.
				if (detail.toolName && detail.code === 'INVALID_REQUEST') {
					this.emitLog({
						level: 'warn',
						source: 'rpc',
						code: detail.code,
						message: detail.reason,
						context: {
							rpc: {
								method: 'ai.tool',
								code: detail.code,
								detail: detail.reason,
								toolName: detail.toolName,
							},
						},
					})
				}
			},
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

	private enrich(event: AppLogEvent): AppLogEvent {
		return this.mapper.enrichEvent(event, {
			sessionId: this.sessionId,
			phase: this.host.phase,
			webview: this.webview,
		})
	}

	private emitLog(event: AppLogEvent) {
		this.host.log(this.enrich(event))
	}

	private fail(input: unknown) {
		if (this.destroyed) return
		const parsed = runtimeFailureSchema.safeParse(input)
		const failure: AppRuntimeFailure = parsed.success
			? parsed.data
			: {
					name: 'AppRuntimeError',
					source: 'runtime',
					message: 'App runtime reported an invalid error',
				}
		const enriched = this.enrich({
			level: 'error',
			source: failure.source ?? 'runtime',
			message: failure.message,
			...(failure.name ? { name: failure.name } : {}),
			...(failure.code ? { code: failure.code } : {}),
			...(failure.stack ? { stack: failure.stack } : {}),
			...(failure.filename ? { filename: failure.filename } : {}),
			...(failure.line !== undefined ? { line: failure.line } : {}),
			...(failure.column !== undefined ? { column: failure.column } : {}),
			...(failure.causes?.length ? { causes: failure.causes } : {}),
			...(failure.breadcrumbs?.length
				? { breadcrumbs: failure.breadcrumbs }
				: {}),
			...(failure.context ? { context: failure.context } : {}),
		})
		const message = formatAppRuntimeFailure({
			...failure,
			filename: enriched.filename,
			line: enriched.line,
			column: enriched.column,
		})
		if (this.dedup.record(enriched)) {
			this.host.log(enriched)
			this.host.error(message)
		}
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
			if (parsed.success) this.emitLog(parsed.data)
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
		const startedAt = Date.now()
		const aiRunId =
			request.method === 'ai.run' &&
			request.args[0] &&
			typeof request.args[0] === 'object' &&
			typeof (request.args[0] as { runId?: unknown }).runId === 'number'
				? (request.args[0] as { runId: number }).runId
				: undefined
		const execute = async () => {
			if (request.method.startsWith('ai.')) {
				if (aiRunId !== undefined) this.aiDiagnostics.delete(aiRunId)
				return this.ai.dispatch(request.method.slice(3), request.args)
			}
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
				if (aiRunId !== undefined) this.aiDiagnostics.delete(aiRunId)
				if (!this.destroyed)
					this.frame.contentWindow?.postMessage(
						{ channel: this.channel, id: request.id, value },
						'*',
					)
			},
			(error: unknown) => {
				const aiDetail =
					aiRunId !== undefined ? this.aiDiagnostics.get(aiRunId) : undefined
				if (aiRunId !== undefined) this.aiDiagnostics.delete(aiRunId)
				const isCancelled =
					error instanceof AppAIError && error.code === 'CANCELLED'
				if (!this.destroyed && !isCancelled) {
					const code =
						error instanceof AppAIError
							? error.code
							: error &&
								  typeof error === 'object' &&
								  typeof (error as { code?: unknown }).code === 'string'
								? (error as { code: string }).code
								: undefined
					const errorMessage =
						error instanceof Error ? error.message : String(error)
					const argsSummary = summarizeRPCArgs(request.method, request.args)
					const rpcLog = this.enrich({
						level: 'error',
						source: 'rpc',
						name: error instanceof Error ? error.name : 'Error',
						...(code ? { code } : {}),
						message: aiDetail?.reason
							? `${request.method}: ${aiDetail.reason}`
							: `${request.method}: ${errorMessage}`,
						context: {
							rpc: {
								method: request.method,
								...(argsSummary ? { argsSummary } : {}),
								durationMs: Date.now() - startedAt,
								...(code ? { code } : {}),
								...(aiDetail?.reason ? { detail: aiDetail.reason } : {}),
								...(aiDetail?.toolName ? { toolName: aiDetail.toolName } : {}),
							},
						},
					})
					if (this.dedup.record(rpcLog)) this.host.log(rpcLog)
				}
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
		this.dedup.flush()
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
