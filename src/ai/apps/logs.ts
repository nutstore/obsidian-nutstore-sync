import type { App } from 'obsidian'
import { dirname } from 'path-browserify'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { readLocalText } from '~/utils/local-vault-io'
import {
	APP_LOG_FILE,
	APP_MANIFEST_FILE,
	appDirectoryPath,
	appIdSchema,
} from './paths'
import type { AppLifecycleQueue } from './lifecycle'
import {
	APP_DIAGNOSTIC_PHASES,
	APP_LOG_LEVELS,
	APP_LOG_SOURCES,
	type AppDiagnosticPhase,
	type AppLogEvent,
	type AppLogLevel,
	type AppLogSource,
} from './diagnostics'

export type {
	AppBreadcrumb,
	AppBreadcrumbCategory,
	AppCSPContext,
	AppDiagnosticContext,
	AppDiagnosticFrame,
	AppDiagnosticPhase,
	AppDiagnosticSourceContext,
	AppErrorCause,
	AppLogEvent,
	AppLogLevel,
	AppLogSource,
	AppResourceContext,
	AppRPCContext,
} from './diagnostics'

export const APP_LOG_FLUSH_DELAY_MS = 250
/** Trigger single-file compaction once `logs.jsonl` exceeds this UTF-8 byte size. */
export const APP_LOG_HIGH_WATERMARK_BYTES = 2 * 1024 * 1024
/** Target maximum UTF-8 byte size after compacting `logs.jsonl`. */
export const APP_LOG_LOW_WATERMARK_BYTES = 512 * 1024
/** Maximum UTF-8 byte size for a single large text field (`message`, `stack`, `filename`). */
export const APP_LOG_MAX_FIELD_BYTES = 64 * 1024

export interface AppLogRetentionLimits {
	readonly highWatermarkBytes: number
	readonly lowWatermarkBytes: number
	readonly maxFieldBytes: number
}

export const DEFAULT_APP_LOG_LIMITS: AppLogRetentionLimits = {
	highWatermarkBytes: APP_LOG_HIGH_WATERMARK_BYTES,
	lowWatermarkBytes: APP_LOG_LOW_WATERMARK_BYTES,
	maxFieldBytes: APP_LOG_MAX_FIELD_BYTES,
}

interface StoredAppLog extends AppLogEvent {
	schemaVersion: 1
	timestamp: number
	appId: string
}

function assertValidRetentionLimits(limits: AppLogRetentionLimits): void {
	if (
		!Number.isSafeInteger(limits.highWatermarkBytes) ||
		limits.highWatermarkBytes <= 0
	) {
		throw new RangeError('highWatermarkBytes must be a positive safe integer')
	}
	if (
		!Number.isSafeInteger(limits.lowWatermarkBytes) ||
		limits.lowWatermarkBytes <= 0 ||
		limits.lowWatermarkBytes > limits.highWatermarkBytes
	) {
		throw new RangeError(
			'lowWatermarkBytes must be a positive safe integer not exceeding highWatermarkBytes',
		)
	}
	if (
		!Number.isSafeInteger(limits.maxFieldBytes) ||
		limits.maxFieldBytes <= 0
	) {
		throw new RangeError('maxFieldBytes must be a positive safe integer')
	}
}

/** Exact UTF-8 byte length matching `TextEncoder`, without allocating a buffer. */
export function utf8ByteLength(value: string): number {
	let bytes = 0
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code <= 0x7f) {
			bytes += 1
		} else if (code <= 0x7ff) {
			bytes += 2
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1)
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4
				i++
			} else {
				bytes += 3
			}
		} else {
			bytes += 3
		}
	}
	return bytes
}

function sliceHeadByBytes(value: string, maxBytes: number): number {
	let bytes = 0
	let i = 0
	while (i < value.length) {
		const code = value.charCodeAt(i)
		let charBytes: number
		let step = 1
		if (code <= 0x7f) {
			charBytes = 1
		} else if (code <= 0x7ff) {
			charBytes = 2
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1)
			if (next >= 0xdc00 && next <= 0xdfff) {
				charBytes = 4
				step = 2
			} else {
				charBytes = 3
			}
		} else {
			charBytes = 3
		}
		if (bytes + charBytes > maxBytes) break
		bytes += charBytes
		i += step
	}
	return i
}

function sliceTailByBytes(
	value: string,
	maxBytes: number,
	minIndex: number,
): number {
	let bytes = 0
	let i = value.length
	while (i > minIndex) {
		const code = value.charCodeAt(i - 1)
		let charBytes: number
		let step = 1
		if (code <= 0x7f) {
			charBytes = 1
		} else if (code <= 0x7ff) {
			charBytes = 2
		} else if (code >= 0xdc00 && code <= 0xdfff && i - 2 >= minIndex) {
			const prev = value.charCodeAt(i - 2)
			if (prev >= 0xd800 && prev <= 0xdbff) {
				charBytes = 4
				step = 2
			} else {
				charBytes = 3
			}
		} else {
			charBytes = 3
		}
		if (bytes + charBytes > maxBytes) break
		bytes += charBytes
		i -= step
	}
	return i
}

/**
 * Keeps strings within `maxBytes` UTF-8 bytes by preserving both head and tail
 * on complete Unicode code-point boundaries (never splitting surrogate pairs).
 */
export function truncateFieldByBytes(value: string, maxBytes: number): string {
	if (value.length * 3 <= maxBytes) return value
	if (utf8ByteLength(value) <= maxBytes) return value

	const maxMarker = `\n… [truncated ${value.length} chars] …\n`
	const maxMarkerBytes = utf8ByteLength(maxMarker)
	if (maxBytes <= maxMarkerBytes) {
		return value.slice(0, sliceHeadByBytes(value, maxBytes))
	}

	const contentBudget = maxBytes - maxMarkerBytes
	const headBudget = Math.floor(contentBudget / 2)
	const tailBudget = contentBudget - headBudget
	const headEnd = sliceHeadByBytes(value, headBudget)
	const tailStart = sliceTailByBytes(value, tailBudget, headEnd)
	const omittedChars = tailStart - headEnd
	if (omittedChars <= 0) return value
	return `${value.slice(0, headEnd)}\n… [truncated ${omittedChars} chars] …\n${value.slice(tailStart)}`
}

function positiveInteger(value: unknown) {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
		? value
		: undefined
}

function validLevel(value: unknown): value is AppLogLevel {
	return (APP_LOG_LEVELS as readonly string[]).includes(value as string)
}

function validSource(value: unknown): value is AppLogSource {
	return (APP_LOG_SOURCES as readonly string[]).includes(value as string)
}

function validPhase(value: unknown): value is AppDiagnosticPhase {
	return (APP_DIAGNOSTIC_PHASES as readonly string[]).includes(value as string)
}

function normalizeEvent(
	event: AppLogEvent,
	maxFieldBytes: number,
): AppLogEvent {
	const line =
		event.line !== undefined ? positiveInteger(event.line) : undefined
	const column =
		event.column !== undefined ? positiveInteger(event.column) : undefined
	const occurrences =
		event.occurrences !== undefined &&
		Number.isInteger(event.occurrences) &&
		event.occurrences >= 1
			? event.occurrences
			: undefined
	const causes = event.causes?.length
		? event.causes.map((cause) => ({
				...cause,
				message: truncateFieldByBytes(
					cause.message || '(empty cause)',
					maxFieldBytes,
				),
				...(cause.stack
					? { stack: truncateFieldByBytes(String(cause.stack), maxFieldBytes) }
					: {}),
			}))
		: undefined
	return {
		level: validLevel(event.level) ? event.level : 'log',
		source: validSource(event.source) ? event.source : 'runtime',
		message: truncateFieldByBytes(
			event.message || '(empty log entry)',
			maxFieldBytes,
		),
		...(event.name ? { name: String(event.name) } : {}),
		...(event.code ? { code: String(event.code) } : {}),
		...(event.stack
			? { stack: truncateFieldByBytes(String(event.stack), maxFieldBytes) }
			: {}),
		...(event.filename
			? {
					filename: truncateFieldByBytes(String(event.filename), maxFieldBytes),
				}
			: {}),
		...(line !== undefined ? { line } : {}),
		...(column !== undefined ? { column } : {}),
		...(event.frames?.length ? { frames: event.frames } : {}),
		...(causes ? { causes } : {}),
		...(event.breadcrumbs?.length ? { breadcrumbs: event.breadcrumbs } : {}),
		...(event.context ? { context: event.context } : {}),
		...(event.fingerprint ? { fingerprint: String(event.fingerprint) } : {}),
		...(occurrences !== undefined ? { occurrences } : {}),
		...(event.sessionId ? { sessionId: String(event.sessionId) } : {}),
		...(validPhase(event.phase) ? { phase: event.phase } : {}),
		...(event.sourceHash ? { sourceHash: String(event.sourceHash) } : {}),
	}
}

function serializeLines(lines: string[]) {
	if (!lines.length) return ''
	return `${lines.join('\n')}\n`
}

function splitNonEmptyLines(content: string): string[] {
	if (!content) return []
	const lines: string[] = []
	for (const line of content.split(/\r?\n/)) {
		if (line.length > 0) lines.push(line)
	}
	return lines
}

function parseLineMeta(raw: string): {
	level?: AppLogLevel
	sessionId?: string
} {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown> | null
		if (!parsed || typeof parsed !== 'object') return {}
		const level = validLevel(parsed.level) ? parsed.level : undefined
		const sessionId =
			typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0
				? parsed.sessionId
				: undefined
		return { level, sessionId }
	} catch {
		return {}
	}
}

function severityRank(level: AppLogLevel | undefined): number {
	if (level === 'error') return 2
	if (level === 'warn') return 1
	return 0
}

/**
 * Dual-watermark byte compaction for a single JSONL diagnostic file.
 *
 * Returns all lines untouched while total UTF-8 size stays at or below
 * `highWatermarkBytes`. Once exceeded, drops whole lines down to
 * `lowWatermarkBytes` in priority order: older sessions before the latest
 * session, and verbose (`debug`/`info`/`log`/malformed) before `warn` before
 * `error`, oldest first within each tier. Chronological order and the newest
 * entry are always preserved.
 */
export function compactAppLogLines(
	existingLines: readonly string[],
	incomingLines: readonly string[],
	limits: AppLogRetentionLimits = DEFAULT_APP_LOG_LIMITS,
): string {
	assertValidRetentionLimits(limits)
	const totalCount = existingLines.length + incomingLines.length
	if (totalCount === 0) return ''

	let totalBytes = 0
	const entries: Array<{
		raw: string
		bytes: number
		isIncoming: boolean
	}> = new Array(totalCount)

	for (let i = 0; i < existingLines.length; i++) {
		const raw = existingLines[i]
		const bytes = utf8ByteLength(raw) + 1
		totalBytes += bytes
		entries[i] = { raw, bytes, isIncoming: false }
	}
	for (let i = 0; i < incomingLines.length; i++) {
		const raw = incomingLines[i]
		const bytes = utf8ByteLength(raw) + 1
		totalBytes += bytes
		entries[existingLines.length + i] = { raw, bytes, isIncoming: true }
	}

	if (totalBytes <= limits.highWatermarkBytes) {
		return serializeLines(entries.map((entry) => entry.raw))
	}

	const metas = entries.map((entry) => parseLineMeta(entry.raw))
	let latestSessionId: string | undefined
	for (let i = metas.length - 1; i >= 0; i--) {
		if (metas[i].sessionId) {
			latestSessionId = metas[i].sessionId
			break
		}
	}

	// Six chronological tiers (evict 0 -> 5, oldest first within each tier):
	// 0: older verbose/malformed, 1: older warn, 2: older error,
	// 3: latest-session verbose/malformed, 4: latest-session warn, 5: latest-session error.
	const buckets: number[][] = [[], [], [], [], [], []]
	const lastIndex = entries.length - 1
	for (let i = 0; i < lastIndex; i++) {
		const meta = metas[i]
		const inLatest =
			entries[i].isIncoming ||
			(latestSessionId !== undefined && meta.sessionId === latestSessionId)
		const tier = (inLatest ? 3 : 0) + severityRank(meta.level)
		buckets[tier].push(i)
	}

	const dropped = new Uint8Array(entries.length)
	let remainingBytes = totalBytes
	for (
		let tier = 0;
		tier < buckets.length && remainingBytes > limits.lowWatermarkBytes;
		tier++
	) {
		for (const index of buckets[tier]) {
			if (remainingBytes <= limits.lowWatermarkBytes) break
			dropped[index] = 1
			remainingBytes -= entries[index].bytes
		}
	}

	const kept: string[] = []
	for (let i = 0; i < entries.length; i++) {
		if (!dropped[i]) kept.push(entries[i].raw)
	}
	return serializeLines(kept)
}

/**
 * App diagnostics are host-owned JSONL in a single file (`logs.jsonl`).
 * Normal flushes append incrementally without reading the file; once size
 * exceeds `highWatermarkBytes`, the file compacts in place to
 * `lowWatermarkBytes` while prioritizing errors and the latest session.
 * Hidden paths are written directly to avoid App hot-reload feedback.
 */
export class AppLogStore {
	private readonly pending = new Map<string, string[]>()
	private readonly timers = new Map<string, number>()
	private readonly limits: AppLogRetentionLimits

	constructor(
		private readonly app: Pick<App, 'vault'>,
		private readonly lifecycle: AppLifecycleQueue,
		limits?: Partial<AppLogRetentionLimits>,
	) {
		this.limits = { ...DEFAULT_APP_LOG_LIMITS, ...limits }
		assertValidRetentionLimits(this.limits)
	}

	private path(id: string) {
		return `${appDirectoryPath(id)}/${APP_LOG_FILE}`
	}

	private schedule(id: string) {
		if (this.timers.has(id)) return
		const timer = window.setTimeout(() => {
			this.timers.delete(id)
			void this.flush(id).catch(() => {})
		}, APP_LOG_FLUSH_DELAY_MS)
		this.timers.set(id, timer)
	}

	append(id: string, input: AppLogEvent) {
		appIdSchema.parse(id)
		const event = normalizeEvent(input, this.limits.maxFieldBytes)
		const entry: StoredAppLog = {
			schemaVersion: 1,
			timestamp: Date.now(),
			appId: id,
			...event,
		}
		const line = JSON.stringify(entry)
		const lines = this.pending.get(id) ?? []
		lines.push(line)
		this.pending.set(id, lines)
		this.schedule(id)
	}

	private async appendLines(id: string, lines: string[]) {
		// A buffered diagnostic must not resurrect an uninstalled App.
		if (
			!(await this.app.vault.adapter.exists(
				`${appDirectoryPath(id)}/${APP_MANIFEST_FILE}`,
			))
		)
			return
		const path = this.path(id)
		await mkdirsVault(this.app.vault, dirname(path))
		const serialized = serializeLines(lines)
		const incomingBytes = utf8ByteLength(serialized)
		const stat = await this.app.vault.adapter.stat(path)
		const existingBytes = stat?.type === 'file' ? stat.size : 0

		if (existingBytes + incomingBytes <= this.limits.highWatermarkBytes) {
			if (!stat) {
				await this.app.vault.adapter.write(path, serialized)
			} else {
				await this.app.vault.adapter.append(path, serialized)
			}
			return
		}

		if (!stat) {
			await this.app.vault.adapter.write(
				path,
				compactAppLogLines([], lines, this.limits),
			)
			return
		}

		await this.app.vault.adapter.process(path, (content) =>
			compactAppLogLines(splitNonEmptyLines(content), lines, this.limits),
		)
	}

	async flush(id: string) {
		const timer = this.timers.get(id)
		if (timer !== undefined) {
			window.clearTimeout(timer)
			this.timers.delete(id)
		}
		const lines = this.pending.get(id)?.splice(0) ?? []
		if (!lines.length) return
		await this.lifecycle.run(id, async () => {
			try {
				await this.appendLines(id, lines)
			} catch {
				// Diagnostics are best-effort and must not break the App lifecycle.
			}
		})
		if (this.pending.get(id)?.length) this.schedule(id)
	}

	async read(id: string) {
		await this.flush(id)
		return this.lifecycle.run(id, async () => {
			const path = this.path(id)
			try {
				return await readLocalText(this.app.vault, path)
			} catch {
				return ''
			}
		})
	}

	async settle() {
		for (const [id, timer] of this.timers) {
			window.clearTimeout(timer)
			this.timers.delete(id)
		}
		const ids = new Set(this.pending.keys())
		await Promise.allSettled([...ids].map((id) => this.flush(id)))
		await this.lifecycle.settle()
	}
}
