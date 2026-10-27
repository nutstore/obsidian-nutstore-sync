import { App, Modal, Setting, type WorkspaceLeaf } from 'obsidian'
import {
	MemoryEditorView,
	MEMORY_EDITOR_VIEW_TYPE,
} from '~/views/memory-editor.view'
import i18n from '~/i18n'

/** A short-lived native editor; hidden-file persistence stays with MemoryService. */
export default class MemoryEditorModal extends Modal {
	private leaf?: WorkspaceLeaf
	private closed = false

	constructor(app: App) {
		super(app)
		this.setTitle(i18n.t('settings.ai.memory.heading'))
		this.modalEl.addClass('ns-memory-editor-modal')
	}

	override async onOpen() {
		const host = this.contentEl.createDiv({ cls: ':uno: h-50vh' })
		const leaf = this.app.workspace.getLeaf('tab')
		this.leaf = leaf
		await leaf.setViewState({ type: MEMORY_EDITOR_VIEW_TYPE })
		if (this.closed) {
			leaf.detach()
			return
		}
		const view = leaf.view
		if (!(view instanceof MemoryEditorView)) {
			this.close()
			return
		}
		host.append(view.contentEl)
		new Setting(this.contentEl)
			.addButton((button) => {
				const updateSaveVisibility = () =>
					button.buttonEl.toggle(view.hasChanges)
				view.registerEvent(
					this.app.workspace.on('editor-change', (_editor, info) => {
						if (info === view) updateSaveVisibility()
					}),
				)
				updateSaveVisibility()
				button
					.setCta()
					.setButtonText(i18n.t('memory.saveAndClose'))
					.onClick(async () => {
						button.setDisabled(true)
						try {
							if (await view.persist()) this.close()
						} finally {
							button.setDisabled(false)
							updateSaveVisibility()
						}
					})
			})
			.addButton((button) =>
				button
					.setButtonText(i18n.t('memory.cancel'))
					.onClick(() => this.close()),
			)
		view.editor.focus()
	}

	override onClose() {
		this.closed = true
		this.leaf?.detach()
		this.leaf = undefined
		this.contentEl.empty()
	}
}
