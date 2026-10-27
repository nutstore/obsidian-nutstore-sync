import type { ModuleScope } from '~/modules/lifecycle'
import { guardAppIO, guardVault } from '~/modules/guard-io'
import { Notice } from 'obsidian'
import { MemoryRepository } from '~/ai/memory/repository'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { posix as pathPosix } from 'path-browserify'
import type NutstorePlugin from '..'
import { BaseService } from './service.interface'
import MemoryEditorModal from '~/components/MemoryEditorModal'

/** Views plugin-owned memory through adapter I/O, including hidden files. */
export default class MemoryService extends BaseService {
	readonly repository: MemoryRepository

	constructor(
		private plugin: NutstorePlugin,
		private readonly scope: ModuleScope,
	) {
		super()
		this.repository = new MemoryRepository(
			guardAppIO(plugin.app, scope.check, scope.track),
			() => ({
				...plugin.settings.ai.memory,
				enabled: !scope.signal.aborted && plugin.settings.ai.memory.enabled,
			}),
		)
	}

	get active() {
		return !this.scope.signal.aborted
	}

	/** The modal owns its temporary native editor and closes it on dismissal. */
	async openNote() {
		if (!this.active) return
		this.scope.ownModal(new MemoryEditorModal(this.plugin.app)).open()
	}

	async readNote(path: string) {
		const scope = this.scope
		const adapter = guardVault(
			this.plugin.app.vault,
			scope.check,
			scope.track,
		).adapter
		return (await adapter.exists(path)) ? await adapter.read(path) : ''
	}

	async saveNote(path: string, before: string, next: string) {
		if (!this.active) return false
		const scope = this.scope
		const vault = guardVault(this.plugin.app.vault, scope.check, scope.track)
		try {
			if ((await this.readNote(path)) !== before) {
				new Notice(i18n.t('memory.changed'))
				return false
			}
			await mkdirsVault(vault, pathPosix.dirname(path))
			await vault.adapter.write(path, next)
			await this.repository.refresh()
			return true
		} catch (error) {
			if (scope.signal.aborted) return false
			logger.error(`Failed to save memory note ${path}`, error)
			new Notice(i18n.t('memory.saveFailed', { path }))
			return false
		}
	}
}
