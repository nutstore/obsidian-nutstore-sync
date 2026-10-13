import {
	MarkdownView,
	Notice,
	type WorkspaceLeaf,
	type ViewStateResult,
} from 'obsidian'
import type MemoryService from '~/services/memory.service'
import i18n from '~/i18n'
import logger from '~/utils/logger'

export const MEMORY_EDITOR_VIEW_TYPE = 'nutstore-memory-editor'

/** Native Obsidian Markdown editing; the hidden memory file is never a TFile. */
export class MemoryEditorView extends MarkdownView {
	private memoryPath = ''
	private savedContent = ''
	private saving = false
	private ready = false

	constructor(
		leaf: WorkspaceLeaf,
		private memory: MemoryService | undefined,
	) {
		super(leaf)
		this.allowNoFile = true
		// Memory has an explicit Save action, rather than native file autosave.
		this.requestSave = () => {}
	}

	override getViewType() {
		return MEMORY_EDITOR_VIEW_TYPE
	}
	override getDisplayText() {
		return i18n.t('settings.ai.memory.heading')
	}

	override async setState(_state: unknown, result: ViewStateResult) {
		if (!this.memory?.active) {
			this.leaf.detach()
			return
		}
		if (this.ready) return
		await super.setState({ mode: 'source', source: true }, result)
		this.memoryPath = this.memory.repository.path
		try {
			this.savedContent = await this.memory.readNote(this.memoryPath)
			this.setViewData(this.savedContent, true)
			this.ready = true
		} catch (error) {
			if (!this.memory?.active) return
			logger.error('Failed to open memory editor', error)
			new Notice(i18n.t('memory.openFailed', { path: this.memoryPath }))
		}
	}

	/** The native view must never save through Vault's ordinary note APIs. */
	override async save() {}

	/** The modal offers saving only when content differs from the loaded file. */
	get hasChanges() {
		return this.ready && this.getViewData() !== this.savedContent
	}

	async persist() {
		if (!this.memory?.active || this.saving || !this.ready) return false
		if (this.getViewData() === this.savedContent) return true
		this.saving = true
		const next = this.getViewData()
		try {
			if (
				await this.memory.saveNote(this.memoryPath, this.savedContent, next)
			) {
				this.savedContent = next
				return this.getViewData() === next
			}
			return false
		} finally {
			this.saving = false
		}
	}
}
