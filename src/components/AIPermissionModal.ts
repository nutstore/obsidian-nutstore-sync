import { App, Modal, Setting } from 'obsidian'
import type { AIFileOperation } from '~/ai/tools/file-operation'
import type { PermissionRequest } from '~/ai/tools/permission-guard'
import {
	applyObsidianModalMountTarget,
	type ChatModalMountTarget,
} from '~/ai/chat/ui/modal-mount'
import i18n from '~/i18n'

export type AIPermissionResult = 'approve' | 'auto-approve-operation' | 'deny'

function getOperationLabel(operation: AIFileOperation): string {
	switch (operation) {
		case 'copy':
			return i18n.t('aiPermission.operations.copy')
		case 'delete':
			return i18n.t('aiPermission.operations.delete')
		case 'edit':
			return i18n.t('aiPermission.operations.edit')
		case 'mkdir':
			return i18n.t('aiPermission.operations.mkdir')
		case 'move':
			return i18n.t('aiPermission.operations.move')
		case 'read':
			return i18n.t('aiPermission.operations.read')
		case 'write':
			return i18n.t('aiPermission.operations.write')
	}
}

export default class AIPermissionModal extends Modal {
	private result: AIPermissionResult = 'deny'
	private resolved = false
	private resolve!: (result: AIPermissionResult) => void
	private cleanupModalMount?: () => void

	constructor(
		app: App,
		private readonly request: PermissionRequest,
		private readonly mountTarget?: ChatModalMountTarget,
	) {
		super(app)
	}

	private renderSinglePathRequest() {
		if (this.request.type !== 'fs' || !('path' in this.request.fs)) {
			return
		}
		const rowEl = this.contentEl.createDiv({ cls: ':uno: mb-2' })

		rowEl.createEl('strong', {
			text: getOperationLabel(this.request.fs.kind),
		})
		rowEl.createEl('code', {
			cls: ':uno: block mt-1 break-all',
			text: this.request.fs.path,
		})
	}

	private renderDualPathRequest() {
		if (
			this.request.type !== 'fs' ||
			!('src' in this.request.fs) ||
			!('dest' in this.request.fs)
		) {
			return
		}
		const rowEl = this.contentEl.createDiv({ cls: ':uno: mb-2' })

		rowEl.createEl('strong', {
			text: getOperationLabel(this.request.fs.kind),
		})

		rowEl.createDiv({
			cls: ':uno: mt-1 font-semibold',
			text: i18n.t('aiPermission.source'),
		})

		rowEl.createEl('code', {
			cls: ':uno: block break-all',
			text: this.request.fs.src,
		})

		rowEl.createDiv({
			cls: ':uno: mt-2 font-semibold',
			text: i18n.t('aiPermission.destination'),
		})

		rowEl.createEl('code', {
			cls: ':uno: block break-all',
			text: this.request.fs.dest,
		})
	}

	private renderSettingsRequest() {
		if (this.request.type !== 'settings') {
			return
		}
		const rowEl = this.contentEl.createDiv({ cls: ':uno: mb-2' })

		rowEl.createEl('strong', {
			text: i18n.t('aiPermission.operations.updateSettings'),
		})
		const summary = this.request.settings.summary
		if (summary) {
			rowEl.createEl('code', {
				cls: ':uno: block mt-1 break-all whitespace-pre-wrap',
				text: summary,
			})
		} else {
			rowEl.createEl('p', {
				cls: ':uno: mt-1 break-all whitespace-pre-wrap',
				text: i18n.t('aiPermission.settings.emptySummary'),
			})
		}
	}

	private renderPurpose() {
		if (!this.request.purpose) return
		const rowEl = this.contentEl.createDiv({ cls: ':uno: mb-2' })
		rowEl.createEl('strong', { text: i18n.t('aiPermission.purpose') })
		rowEl.createEl('p', {
			cls: ':uno: mt-1 break-words',
			text: this.request.purpose,
		})
	}

	onOpen() {
		this.setTitle(i18n.t('aiPermission.title'))

		const { contentEl } = this
		contentEl.empty()

		if (this.request.sessionTitle) {
			contentEl.createEl('p', {
				cls: ':uno: font-semibold',
				text: i18n.t('aiPermission.sessionLabel', {
					title: this.request.sessionTitle,
				}),
			})
		}

		contentEl.createEl('p', {
			text: i18n.t('aiPermission.message'),
		})
		contentEl.createEl('p', {
			text: i18n.t('aiPermission.sessionScopeHint'),
		})
		this.renderPurpose()

		if (this.request.type === 'settings') {
			this.renderSettingsRequest()
		} else if (
			this.request.fs.kind === 'copy' ||
			this.request.fs.kind === 'move'
		) {
			this.renderDualPathRequest()
		} else {
			this.renderSinglePathRequest()
		}

		new Setting(contentEl)
			.addButton((button) => {
				button.buttonEl.addClass('mod-warning')
				button.setButtonText(i18n.t('aiPermission.deny')).onClick(() => {
					this.result = 'deny'
					this.close()
				})
			})
			.addButton((button) =>
				button.setButtonText(i18n.t('aiPermission.allowOnce')).onClick(() => {
					this.result = 'approve'
					this.close()
				}),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('aiPermission.alwaysAllow'))
					.setCta()
					.onClick(() => {
						this.result = 'auto-approve-operation'
						this.close()
					}),
			)
	}

	onClose() {
		this.cleanupModalMount?.()
		this.cleanupModalMount = undefined
		const { contentEl } = this
		contentEl.empty()
		if (!this.resolved) {
			this.resolved = true
			this.resolve(this.result)
		}
	}

	openAndWait(): Promise<AIPermissionResult> {
		return new Promise((resolve) => {
			this.resolve = resolve
			super.open()
			this.cleanupModalMount = applyObsidianModalMountTarget(
				this,
				this.mountTarget,
			)
		})
	}
}
