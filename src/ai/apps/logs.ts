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

export const APP_LOG_FLUSH_DELAY_MS = 250

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

function normalizeEvent(event: AppLogEvent): AppLogEvent {
	return {
		level: validLevel(event.level) ? event.level : 'log',
		source: validSource(event.source) ? event.source : 'runtime',
		message: event.message || '(empty log entry)',
		...(event.stack ? { stack: String(event.stack) } : {}),
		...(event.filename ? { filename: String(event.filename) } : {}),
		...(event.line !== undefined && positiveInteger(event.line) !== undefined
			? { line: event.line }
			: {}),
		...(event.column !== undefined &&
		positiveInteger(event.column) !== undefined
			? { column: event.column }
			: {}),
	}
}

function serializeLines(lines: string[]) {
	if (!lines.length) return ''
	return `${lines.join('\n')}\n`
}

/**
 * App diagnostics are host-owned JSONL. Writes are batched, but logs are
 * retained without truncation or dropping so diagnostics stay complete.
 * Hidden paths are written directly to avoid App hot-reload feedback.
 */
export class AppLogStore {
	private readonly pending = new Map<string, string[]>()
	private readonly timers = new Map<string, number>()

	constructor(
		private readonly app: Pick<App, 'vault'>,
		private readonly lifecycle: AppLifecycleQueue,
	) {}

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
		const event = normalizeEvent(input)
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
		if (!(await this.app.vault.adapter.exists(path)))
			await this.app.vault.adapter.write(path, '')
		await this.app.vault.adapter.process(path, (content) => {
			const separator =
				content.length > 0 && !content.endsWith('\n') ? '\n' : ''
			return `${content}${separator}${serializeLines(lines)}`
		})
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
