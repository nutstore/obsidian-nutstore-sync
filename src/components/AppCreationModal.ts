import {
	App,
	type ButtonComponent,
	Modal,
	Notice,
	Setting,
	type TextAreaComponent,
} from 'obsidian'
import type { AppCreationDetails } from '~/ai/apps/create-app-prompt'
import { appError } from '~/ai/apps/error'
import i18n from '~/i18n'

/**
 * Native Obsidian controls keep theme chrome authoritative. Custom layout only
 * turns the short form into one compact column instead of a settings row.
 */
export default class AppCreationModal extends Modal {
	private name = ''
	private description = ''
	private descriptionInput?: TextAreaComponent
	private submitButton?: ButtonComponent
	private submitting = false

	constructor(
		app: App,
		private readonly onCreate: (details: AppCreationDetails) => Promise<void>,
	) {
		super(app)
		this.setTitle(i18n.t('apps.createApp'))
		this.modalEl.addClass('ns-app-create-modal')
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()
		const formEl = contentEl.createDiv({ cls: 'ns-app-create-form' })

		new Setting(formEl)
			.setName(i18n.t('apps.createAppName'))
			.setDesc(i18n.t('apps.createAppNameDesc'))
			.setClass('ns-app-create-field')
			.addText((text) =>
				text
					.setPlaceholder(i18n.t('apps.createAppNamePlaceholder'))
					.onChange((value) => {
						this.name = value
					}),
			)

		new Setting(formEl)
			.setName(i18n.t('apps.createAppDescription'))
			.setDesc(i18n.t('apps.createAppDescriptionDesc'))
			.setClass('ns-app-create-field')
			.addTextArea((text) => {
				this.descriptionInput = text
				text.inputEl.rows = 6
				text.inputEl.setAttribute('aria-required', 'true')
				text
					.setPlaceholder(i18n.t('apps.createAppDescriptionPlaceholder'))
					.onChange((value) => {
						this.description = value
						this.updateSubmitState()
					})
			})

		new Setting(contentEl)
			.setClass('ns-app-create-actions')
			.addButton((button) =>
				button
					.setButtonText(i18n.t('apps.cancel'))
					.setDisabled(this.submitting)
					.onClick(() => this.close()),
			)
			.addButton((button) => {
				this.submitButton = button
				button
					.setCta()
					.setButtonText(i18n.t('apps.create'))
					.onClick(() => void this.submit())
				this.updateSubmitState()
			})

		this.descriptionInput?.inputEl.focus()
	}

	onClose() {
		this.contentEl.empty()
	}

	private updateSubmitState() {
		this.submitButton?.setDisabled(this.submitting || !this.description.trim())
	}

	private async submit() {
		const description = this.description.trim()
		if (this.submitting || !description) return

		this.submitting = true
		this.descriptionInput?.setDisabled(true)
		this.updateSubmitState()
		try {
			await this.onCreate({ name: this.name, description })
			this.close()
		} catch (error) {
			new Notice(appError(error))
			this.submitting = false
			this.descriptionInput?.setDisabled(false)
			this.updateSubmitState()
		}
	}
}
