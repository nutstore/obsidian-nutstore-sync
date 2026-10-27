import type { IFileSystem } from 'just-bash/browser'
import type { App } from 'obsidian'
import logger from '~/utils/logger'
import {
	DEFAULT_MEMORY_NOTE_PATH,
	editMemoryNote,
	listMemoryEntries,
	normalizeMemoryNotePath,
	type MemoryEntry,
	type MemoryEdit,
	type MemoryEditResult,
	type MemorySettings,
} from './memory-note'

/** The writes go through the caller's filesystem so permission and undo apply. */
export type MemoryNoteFileSystem = Pick<
	IFileSystem,
	'exists' | 'readFileBuffer' | 'writeFile'
>

/**
 * Owns where the memory note lives and the cached content disclosed to the
 * agent. The note on disk is the only state; the cache is refreshed before
 * every user message and after every edit.
 */
export class MemoryRepository {
	private content = ''
	private edits: Promise<unknown> = Promise.resolve()

	constructor(
		private app: App,
		private settings: () => MemorySettings,
	) {}

	get enabled() {
		return this.settings().enabled
	}

	/** Vault-relative path; an invalid setting falls back to the default note. */
	get path() {
		return (
			normalizeMemoryNotePath(this.settings().path) ?? DEFAULT_MEMORY_NOTE_PATH
		)
	}

	async refresh() {
		if (!this.enabled) {
			this.content = ''
			return
		}
		const path = this.path
		try {
			const adapter = this.app.vault.adapter
			this.content = (await adapter.exists(path))
				? await adapter.read(path)
				: ''
		} catch (error) {
			this.content = ''
			logger.warn(`Failed to read memory note ${path}`, error)
		}
	}

	/** Current lines; context decides which additions are unseen and fit its budget. */
	getEntries(): MemoryEntry[] {
		return this.enabled ? listMemoryEntries(this.content) : []
	}

	/** Serialized, so parallel tool calls never lose each other's entries. */
	edit(fs: MemoryNoteFileSystem, edit: MemoryEdit): Promise<MemoryEditResult> {
		const run = this.edits.then(async () => {
			const virtualPath = `/${this.path}`
			const before = (await fs.exists(virtualPath))
				? new TextDecoder('utf-8', { ignoreBOM: true }).decode(
						await fs.readFileBuffer(virtualPath),
					)
				: ''
			// Even a rejected edit has read the newest note; do not retain stale context.
			this.content = before
			const result = editMemoryNote(before, edit)
			if (result.content !== before) {
				await fs.writeFile(virtualPath, result.content)
			}
			this.content = result.content
			return result
		})
		this.edits = run.catch(() => undefined)
		return run
	}
}
