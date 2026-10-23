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

export const APP_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const APP_LOG_MAX_BYTES = 1_048_576
export const APP_LOG_MAX_ENTRIES = 5_000
export const APP_LOG_MAX_EVENT_CHARS = 16_000
export const APP_LOG_FLUSH_DELAY_MS = 250

const RATE_WINDOW_MS = 10_000
const MAX_EVENTS_PER_WINDOW = 200
const MAX_MESSAGE_CHARS = 4_000
const MAX_STACK_CHARS = 12_000
const MAX_LOCATION_CHARS = 1_000
type TimerHost = Pick<Window, 'setTimeout' | 'clearTimeout'>

function timerHost(): TimerHost {
	if (typeof window !== 'undefined') return window
	// Timers are host-agnostic; Node-based tests do not define a Window.
	// eslint-disable-next-line obsidianmd/no-global-this -- Use the platform timer outside Obsidian.
	return globalThis
}

export type AppLogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error'
export type AppLogSource =
	'console' | 'startup' | 'uncaught' | 'unhandled-rejection' | 'runtime'

/** Runtime diagnostics emitted by the sandbox and stored with App identity. */
export interface AppLogEvent {
	level: AppLogLevel
	source: AppLogSource
	message: string
	stack?: string
	filename?: string
	line?: number
	column?: number
}

interface StoredAppLog extends AppLogEvent {
	schemaVersion: 1
	timestamp: number
	appId: string
}

interface RateBucket {
	startedAt: number
	count: number
	dropped: number
}

function trim(value: string, maximum: number) {
	return value.length > maximum ? `${value.slice(0, maximum)}...` : value
}

function positiveInteger(value: unknown) {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
		? value
		: undefined
}

function validLevel(value: unknown): value is AppLogLevel {
	return ['debug', 'info', 'log', 'warn', 'error'].includes(value as string)
}

function validSource(value: unknown): value is AppLogSource {
	return [
		'console',
		'startup',
		'uncaught',
		'unhandled-rejection',
		'runtime',
	].includes(value as string)
}

function parseLine(line: string): StoredAppLog | undefined {
	if (!line.trim()) return undefined
	try {
		const value: unknown = JSON.parse(line)
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return undefined
		const record = value as Record<string, unknown>
		if (
			record.schemaVersion !== 1 ||
			typeof record.timestamp !== 'number' ||
			!Number.isFinite(record.timestamp) ||
			typeof record.appId !== 'string' ||
			!appIdSchema.safeParse(record.appId).success ||
			!validLevel(record.level) ||
			!validSource(record.source) ||
			typeof record.message !== 'string'
		)
			return undefined
		return {
			schemaVersion: 1,
			timestamp: record.timestamp,
			appId: record.appId,
			level: record.level,
			source: record.source,
			message: record.message,
			...(typeof record.stack === 'string' ? { stack: record.stack } : {}),
			...(typeof record.filename === 'string'
				? { filename: record.filename }
				: {}),
			...(positiveInteger(record.line) !== undefined
				? { line: positiveInteger(record.line) }
				: {}),
			...(positiveInteger(record.column) !== undefined
				? { column: positiveInteger(record.column) }
				: {}),
		}
	} catch {
		return undefined
	}
}

function normalizeEvent(event: AppLogEvent): AppLogEvent {
	return {
		level: validLevel(event.level) ? event.level : 'log',
		source: validSource(event.source) ? event.source : 'runtime',
		message: trim(event.message || '(empty log entry)', MAX_MESSAGE_CHARS),
		...(event.stack
			? { stack: trim(String(event.stack), MAX_STACK_CHARS) }
			: {}),
		...(event.filename
			? { filename: trim(String(event.filename), MAX_LOCATION_CHARS) }
			: {}),
		...(event.line !== undefined && positiveInteger(event.line) !== undefined
			? { line: event.line }
			: {}),
		...(event.column !== undefined &&
		positiveInteger(event.column) !== undefined
			? { column: event.column }
			: {}),
	}
}

function retainLines(lines: string[], now: number) {
	const cutoff = now - APP_LOG_RETENTION_MS
	const retained = lines.filter((line) => {
		const entry = parseLine(line)
		return !!entry && entry.timestamp >= cutoff
	})
	const newest = retained.slice(-APP_LOG_MAX_ENTRIES)
	const encoder = new TextEncoder()
	let bytes = 0
	let start = newest.length
	for (let index = newest.length - 1; index >= 0; index--) {
		const size = encoder.encode(newest[index]).byteLength + 1
		if (bytes + size > APP_LOG_MAX_BYTES) break
		bytes += size
		start = index
	}
	return newest.slice(start)
}

function serializeLines(lines: string[]) {
	if (!lines.length) return ''
	return `${lines.join('\n')}\n`
}

/**
 * App diagnostics are host-owned JSONL. Writes are batched, rate-limited and
 * pruned by age, count and bytes so a noisy App cannot grow the vault without
 * bound. Hidden paths are written directly to avoid App hot-reload feedback.
 */
export class AppLogStore {
	private readonly pending = new Map<string, string[]>()
	private readonly timers = new Map<string, number>()
	private readonly rates = new Map<string, RateBucket>()
	private readonly queues = new Map<string, Promise<unknown>>()

	constructor(private readonly app: Pick<App, 'vault'>) {}

	private path(id: string) {
		return `${appDirectoryPath(id)}/${APP_LOG_FILE}`
	}

	private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
		const next = (this.queues.get(id) ?? Promise.resolve())
			.catch(() => {})
			.then(action)
		this.queues.set(id, next)
		void next
			.finally(() => {
				if (this.queues.get(id) === next) this.queues.delete(id)
			})
			.catch(() => {})
		return next
	}

	private schedule(id: string) {
		if (this.timers.has(id)) return
		const timer = timerHost().setTimeout(() => {
			this.timers.delete(id)
			void this.flush(id).catch(() => {})
		}, APP_LOG_FLUSH_DELAY_MS)
		this.timers.set(id, timer)
	}

	private accept(id: string) {
		const now = Date.now()
		let bucket = this.rates.get(id)
		if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
			bucket = { startedAt: now, count: 0, dropped: 0 }
			this.rates.set(id, bucket)
		}
		if (bucket.count >= MAX_EVENTS_PER_WINDOW) {
			bucket.dropped++
			this.schedule(id)
			return false
		}
		bucket.count++
		return true
	}

	append(id: string, input: AppLogEvent) {
		appIdSchema.parse(id)
		if (!this.accept(id)) return
		const event = normalizeEvent(input)
		const entry: StoredAppLog = {
			schemaVersion: 1,
			timestamp: Date.now(),
			appId: id,
			...event,
		}
		let line = JSON.stringify(entry)
		if (line.length > APP_LOG_MAX_EVENT_CHARS) {
			line = JSON.stringify({
				...entry,
				message: trim(entry.message, 1_000),
				stack: entry.stack ? trim(entry.stack, 4_000) : undefined,
			})
		}
		const lines = this.pending.get(id) ?? []
		lines.push(line)
		this.pending.set(id, lines)
		this.schedule(id)
	}

	private droppedNotice(id: string) {
		const bucket = this.rates.get(id)
		if (!bucket?.dropped) return undefined
		const dropped = bucket.dropped
		bucket.dropped = 0
		const entry: StoredAppLog = {
			schemaVersion: 1,
			timestamp: Date.now(),
			appId: id,
			level: 'warn',
			source: 'runtime',
			message: trim(
				`App runtime emitted ${dropped} log entries beyond the rate limit; they were dropped.`,
				MAX_MESSAGE_CHARS,
			),
		}
		return JSON.stringify(entry)
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
		if (!(await this.app.vault.adapter.exists(path)))
			await this.app.vault.adapter.write(path, '')
		await this.app.vault.adapter.process(path, (content) => {
			const existing = content.split('\n').filter((line) => line.trim())
			return serializeLines(retainLines([...existing, ...lines], Date.now()))
		})
	}

	async flush(id: string) {
		const timer = this.timers.get(id)
		if (timer !== undefined) {
			timerHost().clearTimeout(timer)
			this.timers.delete(id)
		}
		const lines = this.pending.get(id)?.splice(0) ?? []
		const dropped = this.droppedNotice(id)
		if (dropped) lines.push(dropped)
		if (!lines.length) return
		await this.serial(id, async () => {
			try {
				await this.appendLines(id, lines)
			} catch {
				// Diagnostics are best-effort and must not break the App lifecycle.
			}
		})
		if (this.pending.get(id)?.length || this.rates.get(id)?.dropped)
			this.schedule(id)
	}

	async read(id: string) {
		await this.flush(id)
		return this.serial(id, async () => {
			const path = this.path(id)
			let content: string
			try {
				content = await readLocalText(this.app.vault, path)
			} catch {
				return ''
			}
			const lines = content.split('\n').filter((line) => line.trim())
			const retained = serializeLines(retainLines(lines, Date.now()))
			if (retained !== content) {
				try {
					await this.app.vault.adapter.write(path, retained)
				} catch {
					// Reading diagnostics remains useful even when pruning cannot persist.
				}
			}
			return retained
		})
	}

	async settle() {
		for (const [id, timer] of this.timers) {
			timerHost().clearTimeout(timer)
			this.timers.delete(id)
		}
		const ids = new Set([
			...this.pending.keys(),
			...this.queues.keys(),
			...this.rates.keys(),
		])
		await Promise.allSettled([...ids].map((id) => this.flush(id)))
		while (this.queues.size) await Promise.allSettled([...this.queues.values()])
	}
}
