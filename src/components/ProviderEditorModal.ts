import { cloneDeep } from 'lodash-es'
import { Modal, Notice, Setting, setIcon } from 'obsidian'
import { createModelConfig, listModels, slugifyProviderId } from '~/ai/config'
import { AIModelConfig, AIProviderConfig } from '~/ai/types'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'
import ModelEditorModal from './ModelEditorModal'
import ProviderCorsConfirmModal from './ProviderCorsConfirmModal'

export default class ProviderEditorModal extends Modal {
	private draft: AIProviderConfig

	constructor(
		private plugin: NutstorePlugin,
		provider: AIProviderConfig,
		private onSave: (provider: AIProviderConfig) => Promise<boolean> | boolean,
		private isNew: boolean,
	) {
		super(plugin.app)
		this.draft = cloneDeep(provider)
	}

	onOpen() {
		this.modalEl.addClass('provider-editor-modal')
		this.contentEl.addClass('provider-editor-modal__content')
		this.render()
	}

	private render() {
		const { contentEl } = this
		contentEl.empty()
		const bodyEl = contentEl.createDiv({ cls: 'provider-editor-modal__body' })
		const footerEl = contentEl.createDiv({
			cls: 'provider-editor-modal__footer',
		})

		bodyEl.createEl('h2', {
			text: this.isNew
				? i18n.t('settings.ai.modals.provider.createTitle')
				: i18n.t('settings.ai.modals.provider.editTitle'),
		})

		new Setting(bodyEl)
			.setName(i18n.t('settings.ai.provider.name'))
			.setDesc(i18n.t('settings.ai.provider.desc'))
			.then((s) => s.settingEl.addClass('setting-required'))
			.addText((text) =>
				text.setValue(this.draft.name).onChange((value) => {
					this.draft.name = value
				}),
			)

		new Setting(bodyEl)
			.setName(i18n.t('settings.ai.provider.baseUrl.name'))
			.setDesc(i18n.t('settings.ai.provider.baseUrl.desc'))
			.then((s) => s.settingEl.addClass('setting-required'))
			.addText((text) =>
				text
					.setPlaceholder('https://api.openai.com/v1')
					.setValue(this.draft.api || '')
					.onChange((value) => {
						this.draft.api = value.trim() || undefined
					}),
			)

		new Setting(bodyEl)
			.setName(i18n.t('settings.ai.provider.apiKey.name'))
			.setDesc(i18n.t('settings.ai.provider.apiKey.desc'))
			.then((s) => s.settingEl.addClass('setting-required'))
			.addText((text) => {
				text.setValue(this.draft.apiKey).onChange((value) => {
					this.draft.apiKey = value
				})
				text.inputEl.type = 'password'
			})

		new Setting(bodyEl)
			.setName(i18n.t('settings.ai.provider.allowBrowserCors.name'))
			.setDesc(i18n.t('settings.ai.provider.allowBrowserCors.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(!!this.draft.allowBrowserCors)
					.onChange(async (value) => {
						if (!value) {
							this.draft.allowBrowserCors = false
							return
						}
						const confirmed = await new ProviderCorsConfirmModal(
							this.app,
						).open()
						if (!confirmed) {
							this.render()
							return
						}
						this.draft.allowBrowserCors = true
					}),
			)

		const modelContainer = bodyEl.createDiv({
			cls: 'provider-editor-modal__models',
		})
		new Setting(modelContainer)
			.setName(i18n.t('settings.ai.models.name'))
			.setDesc(i18n.t('settings.ai.models.desc'))
			.addButton((button) =>
				button.setButtonText(i18n.t('settings.ai.models.add')).onClick(() => {
					new ModelEditorModal(
						this.plugin,
						createModelConfig(),
						async (model) => {
							if (this.draft.models[model.id]) {
								new Notice(i18n.t('settings.ai.errors.duplicateModelId'))
								return false
							}
							this.draft.models = {
								...this.draft.models,
								[model.id]: model,
							}
							this.render()
							return true
						},
						true,
						{
							findPresetOnSave: true,
							presetProviderApi: this.draft.api,
						},
					).open()
				}),
			)

		const models = listModels(this.draft)
		if (models.length === 0) {
			modelContainer.createDiv({
				cls: 'setting-item-description',
				text: i18n.t('settings.ai.models.empty'),
			})
		}

		for (const model of models) {
			new Setting(modelContainer)
				.setName(model.name || i18n.t('settings.ai.unnamedModel'))
				.then((s) => {
					const inputModalities = model.modalities?.input ?? ['text']
					s.descEl.createDiv({ cls: 'modality-badge-row' }, (row) => {
						for (const modality of inputModalities) {
							row.createSpan({
								cls: `modality-badge modality-badge-${modality}`,
								text: modality,
							})
						}
					})
				})
				.addButton((button) =>
					button
						.setButtonText(i18n.t('settings.ai.modals.model.edit'))
						.onClick(() => {
							new ModelEditorModal(
								this.plugin,
								model,
								async (savedModel) => {
									const isRename = savedModel.id !== model.id
									if (isRename && this.draft.models[savedModel.id]) {
										new Notice(i18n.t('settings.ai.errors.duplicateModelId'))
										return false
									}
									const { [model.id]: _old, ...rest } = this.draft.models
									this.draft.models = { ...rest, [savedModel.id]: savedModel }
									this.render()
									return true
								},
								false,
							).open()
						}),
				)
				.addButton((button) => {
					let confirmDelete = false

					const resetButton = () => {
						confirmDelete = false
						button.buttonEl.empty()
						setIcon(button.buttonEl, 'trash')
						button.buttonEl.removeClass('mod-warning')
					}

					button.setIcon('trash').onClick(() => {
						if (!confirmDelete) {
							confirmDelete = true
							button.buttonEl.empty()
							button.buttonEl.createSpan({
								text: i18n.t('settings.ai.modals.confirmDeleteLabel'),
							})
							button.buttonEl.addClass('mod-warning')
							return
						}
						this.deleteModel(model)
					})
					button.buttonEl.addEventListener('blur', resetButton)
				})
		}

		new Setting(footerEl)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.filters.save'))
					.setCta()
					.onClick(async () => {
						try {
							const toSave = cloneDeep(this.draft)
							if (this.isNew) {
								toSave.id = slugifyProviderId(toSave.name)
							}
							const ok = await this.onSave(toSave)
							if (!ok) return
							new Notice(i18n.t('settings.ai.modals.provider.saved'))
							this.close()
						} catch (error) {
							logger.error(error)
							new Notice(
								error instanceof Error
									? error.message
									: i18n.t('settings.ai.errors.saveFailed'),
							)
						}
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.filters.cancel'))
					.onClick(() => this.close()),
			)
	}

	private deleteModel(model: AIModelConfig) {
		const { [model.id]: _deleted, ...models } = this.draft.models
		this.draft.models = models
		new Notice(i18n.t('settings.ai.modals.model.deleted'))
		this.render()
	}

	onClose() {
		this.modalEl.removeClass('provider-editor-modal')
		this.contentEl.removeClass('provider-editor-modal__content')
		this.contentEl.empty()
	}
}
