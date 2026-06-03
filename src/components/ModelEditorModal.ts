import { cloneDeep } from 'lodash-es'
import { Modal, Notice, Setting } from 'obsidian'
import { findPresetModelById } from '~/ai/config'
import { AIModelConfig } from '~/ai/types'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

interface ModelEditorOptions {
	findPresetOnSave?: boolean
	presetProviderApi?: string
}

const INPUT_MODALITY_OPTIONS: AIModelConfig['modalities']['input'] = [
	'text',
	'image',
	'pdf',
	'video',
	'audio',
]

export default class ModelEditorModal extends Modal {
	private draft: AIModelConfig
	private lastMatchedModelId?: string
	private updateInputModalityTags?: () => void

	constructor(
		plugin: NutstorePlugin,
		model: AIModelConfig,
		private onSave: (model: AIModelConfig) => Promise<boolean> | boolean,
		private isNew: boolean,
		private options: ModelEditorOptions = {},
	) {
		super(plugin.app)
		this.draft = cloneDeep(model)
		this.ensureModalities()
		if (
			this.isNew &&
			!this.draft.id.trim() &&
			this.draft.modalities.input.length === 1 &&
			this.draft.modalities.input[0] === 'text'
		) {
			this.draft.modalities.input = []
		}
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h2', {
			text: this.isNew
				? i18n.t('settings.ai.modals.model.createTitle')
				: i18n.t('settings.ai.modals.model.editTitle'),
		})

		new Setting(contentEl)
			.setName(i18n.t('settings.ai.model.id'))
			.setDesc(i18n.t('settings.ai.model.idDesc'))
			.then((s) => s.settingEl.addClass('setting-required'))
			.addText((text) => {
				text.setValue(this.draft.id).onChange((value) => {
					this.draft.id = value
					this.draft.name = value
					this.lastMatchedModelId = undefined
				})
				text.inputEl.addEventListener('blur', () => this.applyPresetModelById())
			})

		const modalitiesSetting = new Setting(contentEl).setName(
			i18n.t('settings.ai.model.inputModalities'),
		)
		const tagContainer = modalitiesSetting.controlEl.createDiv({
			cls: 'model-editor-modality-tags',
		})
		const updateTags = () => {
			for (const child of Array.from(tagContainer.children)) {
				const button = child as HTMLButtonElement
				const modality = button.dataset
					.modality as AIModelConfig['modalities']['input'][number]
				const selected = this.draft.modalities.input.includes(modality)
				button.classList.toggle('is-active', selected)
			}
		}
		this.updateInputModalityTags = updateTags
		for (const modality of INPUT_MODALITY_OPTIONS) {
			const button = tagContainer.createEl('button', {
				text: modality,
				cls: 'model-editor-modality-tag',
			})
			button.type = 'button'
			button.dataset.modality = modality
			button.addEventListener('click', () => {
				const next = this.draft.modalities.input.includes(modality)
					? this.draft.modalities.input.filter((item) => item !== modality)
					: [...this.draft.modalities.input, modality]
				this.draft.modalities.input = this.normalizeInputModalities(next)
				updateTags()
			})
		}
		updateTags()

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.filters.save'))
					.setCta()
					.onClick(async () => {
						if (!this.draft.id.trim()) {
							new Notice(i18n.t('settings.ai.errors.emptyModelId'))
							return
						}
						try {
							const toSave = cloneDeep(this.draft)
							toSave.id = toSave.id.trim()
							toSave.modalities.input = this.normalizeInputModalities(
								toSave.modalities.input,
							)
							const ok = await this.onSave(toSave)
							if (!ok) return
							this.close()
						} catch (error) {
							logger.error(error)
							new Notice(
								`${i18n.t('settings.ai.errors.saveFailed')}: ${(error as Error)?.message}`,
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

	onClose() {
		this.contentEl.empty()
		this.updateInputModalityTags = undefined
	}

	private ensureModalities() {
		this.draft.modalities = this.draft.modalities || { input: [], output: [] }
		this.draft.modalities.input = this.normalizeInputModalities(
			this.draft.modalities.input,
		)
		this.draft.modalities.output = this.draft.modalities.output || []
	}

	private normalizeInputModalities(
		modalities: AIModelConfig['modalities']['input'],
	): AIModelConfig['modalities']['input'] {
		const unique = new Set(modalities)
		return INPUT_MODALITY_OPTIONS.filter((modality) => unique.has(modality))
	}

	private applyPresetModelById() {
		if (!this.options.findPresetOnSave) return
		const trimmedId = this.draft.id.trim()
		if (!trimmedId || this.lastMatchedModelId === trimmedId) return
		this.lastMatchedModelId = trimmedId
		const presetModel = findPresetModelById(
			trimmedId,
			this.options.presetProviderApi,
		)
		if (!presetModel) return
		this.draft = {
			...cloneDeep(presetModel),
			id: trimmedId,
			modalities: {
				...cloneDeep(presetModel.modalities),
				input: this.normalizeInputModalities(presetModel.modalities.input),
			},
		}
		this.updateInputModalityTags?.()
	}
}
