import { Notice } from 'obsidian'
import { MemoryRepository } from '~/ai/memory/repository'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import {
	MemoryEditorView,
	MEMORY_EDITOR_VIEW_TYPE,
} from '~/views/memory-editor.view'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { posix as pathPosix } from 'path-browserify'
import type NutstorePlugin from '..'
import { BaseService } from './service.interface'
import MemoryEditorModal from '~/components/MemoryEditorModal'

/** Views plugin-owned memory through adapter I/O, including hidden files. */
export default class MemoryService extends BaseService {
	readonly repository: MemoryRepository

	constructor(private plugin: NutstorePlugin) {
		super()
		this.repository = new MemoryRepository(
			plugin.app,
			() => plugin.settings.ai.memory,
		)
	}

	override onload() {
		this.plugin.registerView(
			MEMORY_EDITOR_VIEW_TYPE,
			(leaf) => new MemoryEditorView(leaf, this),
		)
		this.plugin.addCommand({
			id: 'open-memory-note',
			name: i18n.t('memory.openCommand'),
			icon: 'brain',
			callback: () => void this.openNote(),
		})
	}

	/** The modal owns its temporary native editor and closes it on dismissal. */
	async openNote() {
		new MemoryEditorModal(this.plugin.app).open()
	}

	async readNote(path: string) {
		const adapter = this.plugin.app.vault.adapter
		return (await adapter.exists(path)) ? await adapter.read(path) : ''
	}

	async saveNote(path: string, before: string, next: string) {
		try {
			if ((await this.readNote(path)) !== before) {
				new Notice(i18n.t('memory.changed'))
				return false
			}
			await mkdirsVault(this.plugin.app.vault, pathPosix.dirname(path))
			await this.plugin.app.vault.adapter.write(path, next)
			await this.repository.refresh()
			return true
		} catch (error) {
			logger.error(`Failed to save memory note ${path}`, error)
			new Notice(i18n.t('memory.saveFailed', { path }))
			return false
		}
	}
}
