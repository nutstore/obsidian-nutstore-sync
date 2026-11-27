import { hash as hashObject } from 'ohash'
import type { AppContent, AppScriptSegment } from './source'

/** Virtual script URL assigned to the assembled App program in the sandbox. */
export const APP_RUNTIME_SCRIPT_URL = 'nutstore-app.js'
/** Number of wrapper lines inserted before `AppContent.javascript` in `runtimeDocument`. */
export const APP_RUNTIME_WRAPPER_LINE_OFFSET = 1
export const APP_ERROR_DEDUP_WINDOW_MS = 5_000

export const APP_LOG_LEVELS = ['debug', 'info', 'log', 'warn', 'error'] as const
export type AppLogLevel = (typeof APP_LOG_LEVELS)[number]

export const APP_LOG_SOURCES = [
	'console',
	'startup',
	'uncaught',
	'unhandled-rejection',
	'csp',
	'resource',
	'rpc',
	'assembly',
	'runtime',
] as const
export type AppLogSource = (typeof APP_LOG_SOURCES)[number]

export const APP_DIAGNOSTIC_PHASES = ['validation', 'live', 'assembly'] as const
export type AppDiagnosticPhase = (typeof APP_DIAGNOSTIC_PHASES)[number]

export const APP_BREADCRUMB_CATEGORIES = [
	'ui',
	'console',
	'rpc',
	'lifecycle',
] as const
export type AppBreadcrumbCategory = (typeof APP_BREADCRUMB_CATEGORIES)[number]

export interface AppDiagnosticSourceContext {
	startLine: number
	lines: string[]
	highlightLine: number
}

export interface AppDiagnosticFrame {
	function?: string
	filename: string
	line?: number
	column?: number
	inApp?: boolean
	raw?: string
	context?: AppDiagnosticSourceContext
}

export interface AppErrorCause {
	name?: string
	code?: string
	message: string
	stack?: string
	frames?: AppDiagnosticFrame[]
}

export interface AppBreadcrumb {
	timestamp: number
	category: AppBreadcrumbCategory
	level?: AppLogLevel
	message: string
	data?: Record<string, unknown>
}

export interface AppCSPContext {
	violatedDirective?: string
	effectiveDirective?: string
	blockedURI?: string
	disposition?: string
	sourceFile?: string
	line?: number
	column?: number
	sample?: string
}

export interface AppRPCContext {
	method: string
	argsSummary?: string
	durationMs?: number
	code?: string
	detail?: string
	toolName?: string
}

export interface AppResourceContext {
	tagName: string
	selector?: string
	url?: string
}

export interface AppDiagnosticContext {
	viewport?: { width: number; height: number }
	colorScheme?: 'light' | 'dark'
	webview?: string
	csp?: AppCSPContext
	rpc?: AppRPCContext
	resource?: AppResourceContext
}

/** Runtime and lifecycle diagnostics stored per App in `logs.jsonl`. */
export interface AppLogEvent {
	level: AppLogLevel
	source: AppLogSource
	message: string
	name?: string
	code?: string
	stack?: string
	filename?: string
	line?: number
	column?: number
	frames?: AppDiagnosticFrame[]
	causes?: AppErrorCause[]
	breadcrumbs?: AppBreadcrumb[]
	context?: AppDiagnosticContext
	fingerprint?: string
	occurrences?: number
	sessionId?: string
	phase?: AppDiagnosticPhase
	sourceHash?: string
}

const MAX_CONTEXT_LINE_CHARS = 240
const CONTEXT_RADIUS = 2
const MAX_FRAMES_WITH_CONTEXT = 3

function truncateContextLine(line: string): string {
	if (line.length <= MAX_CONTEXT_LINE_CHARS) return line
	return `${line.slice(0, MAX_CONTEXT_LINE_CHARS - 1)}…`
}

function isRuntimeScriptFilename(filename: string | undefined): boolean {
	if (!filename) return false
	return (
		filename === APP_RUNTIME_SCRIPT_URL ||
		filename.endsWith(`/${APP_RUNTIME_SCRIPT_URL}`)
	)
}

function parseLocationSuffix(
	location: string,
): { filename: string; line?: number; column?: number } | undefined {
	const trimmed = location.trim()
	if (!trimmed) return undefined
	const lineCol = /^(.*):(\d+):(\d+)$/.exec(trimmed)
	if (lineCol) {
		return {
			filename: lineCol[1],
			line: Number(lineCol[2]),
			column: Number(lineCol[3]),
		}
	}
	const lineOnly = /^(.*):(\d+)$/.exec(trimmed)
	if (lineOnly) {
		return {
			filename: lineOnly[1],
			line: Number(lineOnly[2]),
		}
	}
	return undefined
}

interface ParsedStackFrame {
	function?: string
	filename: string
	line?: number
	column?: number
	raw: string
}

/** Parse both V8/Chromium (`at fn (file:l:c)`) and JSC/Firefox (`fn@file:l:c`) stack frames. */
export function parseStackFrames(stack: string): ParsedStackFrame[] {
	const frames: ParsedStackFrame[] = []
	for (const rawLine of stack.split(/\r?\n/)) {
		const trimmed = rawLine.trim()
		if (!trimmed) continue

		// V8 / Chromium: "at async fn (file:12:34)" or "at file:12:34"
		if (trimmed.startsWith('at ')) {
			const body = trimmed.slice(3).trim()
			const parenEnd = body.endsWith(')') ? body.lastIndexOf(' (') : -1
			if (parenEnd > 0) {
				const fn = body.slice(0, parenEnd).trim()
				const loc = parseLocationSuffix(body.slice(parenEnd + 2, -1))
				if (loc && loc.filename) {
					frames.push({
						...(fn ? { function: fn } : {}),
						...loc,
						raw: trimmed,
					})
					continue
				}
			}
			const loc = parseLocationSuffix(body)
			if (loc && loc.filename) {
				frames.push({ ...loc, raw: trimmed })
				continue
			}
			continue
		}

		// JavaScriptCore / WebKit / Firefox: "fn@file:12:34" or "@file:12:34"
		const atIndex = trimmed.indexOf('@')
		if (atIndex >= 0) {
			const fn = trimmed.slice(0, atIndex).trim()
			const loc = parseLocationSuffix(trimmed.slice(atIndex + 1))
			if (loc && loc.filename) {
				frames.push({
					...(fn ? { function: fn } : {}),
					...loc,
					raw: trimmed,
				})
			}
		}
	}
	return frames
}

export interface MappedLocation {
	filename: string
	line?: number
	column?: number
	inApp: boolean
	context?: AppDiagnosticSourceContext
}

/**
 * Resolves sandbox script coordinates (`nutstore-app.js:line:col`) back to
 * authored App files, line numbers and surrounding source context.
 */
export class AppSourceMapper {
	readonly sourceHash: string
	private readonly lines: string[]
	private readonly segments: readonly AppScriptSegment[]

	constructor(content: AppContent) {
		this.sourceHash = hashObject({
			html: content.html,
			css: content.css,
			javascript: content.javascript,
		})
		this.lines = content.javascript
			? content.javascript.replace(/\r\n/g, '\n').split('\n')
			: []
		this.segments = content.scriptMap ?? []
	}

	private findSegment(contentLine: number): AppScriptSegment | undefined {
		for (const segment of this.segments) {
			if (
				contentLine >= segment.startLine &&
				contentLine < segment.startLine + segment.lineCount
			) {
				return segment
			}
		}
		return undefined
	}

	private extractContext(
		contentLine: number,
		minContentLine: number,
		maxContentLine: number,
		sourceStartLine: number,
		segmentStartLine: number,
	): AppDiagnosticSourceContext | undefined {
		if (!this.lines.length) return undefined
		const start = Math.max(minContentLine, contentLine - CONTEXT_RADIUS)
		const end = Math.min(
			maxContentLine,
			this.lines.length,
			contentLine + CONTEXT_RADIUS,
		)
		if (start > end) return undefined
		const slice: string[] = []
		for (let line = start; line <= end; line++) {
			slice.push(truncateContextLine(this.lines[line - 1] ?? ''))
		}
		return {
			startLine: sourceStartLine + (start - segmentStartLine),
			lines: slice,
			highlightLine: sourceStartLine + (contentLine - segmentStartLine),
		}
	}

	mapLocation(
		filename: string | undefined,
		line: number | undefined,
		column?: number,
		includeContext = true,
	): MappedLocation | undefined {
		if (!filename) return undefined
		if (!isRuntimeScriptFilename(filename)) {
			return {
				filename,
				...(line !== undefined ? { line } : {}),
				...(column !== undefined ? { column } : {}),
				inApp: false,
			}
		}
		if (line === undefined || line <= APP_RUNTIME_WRAPPER_LINE_OFFSET) {
			return {
				filename,
				...(line !== undefined ? { line } : {}),
				...(column !== undefined ? { column } : {}),
				inApp: true,
			}
		}
		const contentLine = line - APP_RUNTIME_WRAPPER_LINE_OFFSET
		const segment = this.findSegment(contentLine)
		if (segment) {
			const mappedLine =
				segment.sourceStartLine + (contentLine - segment.startLine)
			const context = includeContext
				? this.extractContext(
						contentLine,
						segment.startLine,
						segment.startLine + segment.lineCount - 1,
						segment.sourceStartLine,
						segment.startLine,
					)
				: undefined
			return {
				filename: segment.path,
				line: mappedLine,
				...(column !== undefined ? { column } : {}),
				inApp: true,
				...(context ? { context } : {}),
			}
		}
		// Fallback when `AppContent` has no `scriptMap` (e.g. synthetic content in tests):
		// preserve reported coordinates while still attaching surrounding lines if available.
		const context =
			includeContext && contentLine >= 1 && contentLine <= this.lines.length
				? this.extractContext(contentLine, 1, this.lines.length, 1, 1)
				: undefined
		return {
			filename,
			line,
			...(column !== undefined ? { column } : {}),
			inApp: true,
			...(context ? { context } : {}),
		}
	}

	parseAndMapStack(stack: string): AppDiagnosticFrame[] {
		const parsed = parseStackFrames(stack)
		const seenContext = new Set<string>()
		const mapped: AppDiagnosticFrame[] = []
		for (const frame of parsed) {
			const wantContext = seenContext.size < MAX_FRAMES_WITH_CONTEXT
			const resolved = this.mapLocation(
				frame.filename,
				frame.line,
				frame.column,
				wantContext,
			)
			if (!resolved) continue
			let context = resolved.context
			if (context) {
				const key = `${resolved.filename}:${resolved.line ?? 0}`
				if (seenContext.has(key)) context = undefined
				else seenContext.add(key)
			}
			mapped.push({
				...(frame.function ? { function: frame.function } : {}),
				filename: resolved.filename,
				...(resolved.line !== undefined ? { line: resolved.line } : {}),
				...(resolved.column !== undefined ? { column: resolved.column } : {}),
				...(resolved.inApp ? { inApp: true } : {}),
				raw: frame.raw,
				...(context ? { context } : {}),
			})
		}
		return mapped
	}

	enrichEvent(
		event: AppLogEvent,
		meta: {
			sessionId?: string
			phase?: AppDiagnosticPhase
			webview?: string
		} = {},
	): AppLogEvent {
		const frames = event.stack
			? this.parseAndMapStack(event.stack)
			: event.frames
		const mappedDirect = this.mapLocation(
			event.filename,
			event.line,
			event.column,
			false,
		)
		const topInApp = frames?.find((frame) => frame.inApp)

		let filename = mappedDirect?.filename ?? event.filename
		let line = mappedDirect?.line ?? event.line
		let column = mappedDirect?.column ?? event.column
		if (
			topInApp &&
			(!filename ||
				(isRuntimeScriptFilename(filename) &&
					!isRuntimeScriptFilename(topInApp.filename)))
		) {
			filename = topInApp.filename
			line = topInApp.line ?? line
			column = topInApp.column ?? column
		}

		const causes = event.causes?.map((cause) => {
			if (!cause.stack) return cause
			const causeFrames = this.parseAndMapStack(cause.stack)
			return causeFrames.length ? { ...cause, frames: causeFrames } : cause
		})

		let context = event.context ? { ...event.context } : undefined
		if (context?.csp?.sourceFile) {
			const cspLoc = this.mapLocation(
				context.csp.sourceFile,
				context.csp.line,
				context.csp.column,
				false,
			)
			if (cspLoc) {
				context = {
					...context,
					csp: {
						...context.csp,
						sourceFile: cspLoc.filename,
						...(cspLoc.line !== undefined ? { line: cspLoc.line } : {}),
						...(cspLoc.column !== undefined ? { column: cspLoc.column } : {}),
					},
				}
			}
		}
		if (meta.webview && (event.level === 'error' || context)) {
			context = { ...context, webview: context?.webview ?? meta.webview }
		}

		const enriched: AppLogEvent = {
			...event,
			...(filename !== undefined ? { filename } : {}),
			...(line !== undefined ? { line } : {}),
			...(column !== undefined ? { column } : {}),
			...(frames?.length ? { frames } : {}),
			...(causes?.length ? { causes } : {}),
			...(context ? { context } : {}),
			...(meta.sessionId
				? { sessionId: event.sessionId ?? meta.sessionId }
				: {}),
			...(meta.phase ? { phase: event.phase ?? meta.phase } : {}),
			sourceHash: event.sourceHash ?? this.sourceHash,
		}

		if (enriched.level === 'error' && !enriched.fingerprint) {
			enriched.fingerprint = computeErrorFingerprint(enriched)
		}
		return enriched
	}
}

function normalizeMessageForFingerprint(message: string): string {
	const firstLine = message.split(/\r?\n/, 1)[0] ?? message
	return firstLine
		.replace(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
			'<uuid>',
		)
		.replace(/\b\d{4,}\b/g, '<num>')
		.slice(0, 160)
}

/** Deterministic fingerprint so burst crash-loops fold cleanly while distinct errors never collide. */
export function computeErrorFingerprint(event: AppLogEvent): string {
	const topFrame =
		event.frames?.find((frame) => frame.inApp) ?? event.frames?.[0]
	const location =
		(event.filename ?? topFrame?.filename)
			? `${event.filename ?? topFrame?.filename}:${event.line ?? topFrame?.line ?? 0}`
			: ''
	const rpcKey = event.context?.rpc
		? `${event.context.rpc.method}:${event.context.rpc.toolName ?? ''}`
		: ''
	const cspKey = event.context?.csp
		? `${event.context.csp.effectiveDirective ?? ''}:${event.context.csp.blockedURI ?? ''}`
		: ''
	return hashObject([
		event.source,
		event.name ?? '',
		event.code ?? '',
		location,
		rpcKey,
		cspKey,
		normalizeMessageForFingerprint(event.message),
	])
}

interface DedupBucket {
	event: AppLogEvent
	count: number
	timer?: number
}

/**
 * Folds bursts of identical runtime errors inside a short window into an exact
 * occurrence count, without ever capping or dropping distinct errors.
 */
export class AppErrorDeduplicator {
	private readonly buckets = new Map<string, DedupBucket>()

	constructor(
		private readonly emitSummary: (event: AppLogEvent) => void,
		private readonly win: Pick<Window, 'setTimeout' | 'clearTimeout'> = window,
		private readonly windowMs = APP_ERROR_DEDUP_WINDOW_MS,
	) {}

	/** Returns true when this error should be emitted immediately; false when folded into an active burst. */
	record(event: AppLogEvent): boolean {
		const key = event.fingerprint ?? computeErrorFingerprint(event)
		const existing = this.buckets.get(key)
		if (existing) {
			existing.count++
			return false
		}
		const bucket: DedupBucket = { event, count: 1 }
		bucket.timer = this.win.setTimeout(() => {
			this.release(key)
		}, this.windowMs)
		this.buckets.set(key, bucket)
		return true
	}

	private release(key: string) {
		const bucket = this.buckets.get(key)
		if (!bucket) return
		if (bucket.timer !== undefined) this.win.clearTimeout(bucket.timer)
		this.buckets.delete(key)
		if (bucket.count > 1) {
			this.emitSummary({
				...bucket.event,
				occurrences: bucket.count,
			})
		}
	}

	flush() {
		for (const key of Array.from(this.buckets.keys())) {
			this.release(key)
		}
	}
}

/** Summarize untrusted RPC arguments for diagnostics without copying large payloads or secrets. */
export function summarizeRPCArgs(method: string, args: unknown[]): string {
	if (method.startsWith('fs.')) {
		const paths = args
			.filter((arg): arg is string => typeof arg === 'string')
			.slice(0, 2)
			.map((value) => (value.length > 160 ? `${value.slice(0, 159)}…` : value))
		return paths.join(' -> ')
	}
	if (method.startsWith('kv.')) {
		if (method === 'kv.get' && typeof args[0] === 'string') return args[0]
		if (method === 'kv.transact' && Array.isArray(args[0])) {
			const keys = args[0]
				.slice(0, 5)
				.map((item) =>
					item &&
					typeof item === 'object' &&
					typeof (item as { key?: unknown }).key === 'string'
						? (item as { key: string }).key
						: '?',
				)
			const suffix = args[0].length > 5 ? ` (+${args[0].length - 5})` : ''
			return `keys=[${keys.join(', ')}]${suffix}`
		}
		return ''
	}
	if (method === 'ai.run' && args[0] && typeof args[0] === 'object') {
		const req = args[0] as {
			streaming?: unknown
			settings?: {
				model?: { providerId?: unknown; modelId?: unknown }
				tools?: Record<string, unknown>
				output?: unknown
			}
			call?: { prompt?: unknown; messages?: unknown[] }
		}
		const parts: string[] = []
		if (req.streaming === true) parts.push('stream')
		if (
			typeof req.settings?.model?.providerId === 'string' &&
			req.settings.model.providerId &&
			typeof req.settings.model.modelId === 'string' &&
			req.settings.model.modelId
		) {
			parts.push(
				`model=${req.settings.model.providerId}/${req.settings.model.modelId}`,
			)
		}
		const toolNames = req.settings?.tools ? Object.keys(req.settings.tools) : []
		if (toolNames.length)
			parts.push(`tools=[${toolNames.slice(0, 5).join(',')}]`)
		if (req.settings?.output) parts.push('structuredOutput')
		if (typeof req.call?.prompt === 'string')
			parts.push(`promptLen=${req.call.prompt.length}`)
		else if (Array.isArray(req.call?.messages))
			parts.push(`messages=${req.call.messages.length}`)
		return parts.join(' ')
	}
	return ''
}
