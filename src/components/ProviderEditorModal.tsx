import { Modal, Notice } from 'obsidian'
import { createModelConfig } from '~/ai/catalog/config'
import {
	fetchProviderModels,
	resolvePresetModel,
} from '~/ai/catalog/fetch-models'
import {
	providerFromEditorDraft,
	providerToEditorDraft,
} from '~/ai/catalog/provider-editor'
import type { AIProviderConfig } from '~/ai/core/types'
import {
	applyObsidianModalMountTarget,
	type ChatModalMountTarget,
} from '~/ai/chat/ui/modal-mount'
import i18n from '~/i18n'
import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import type NutstorePlugin from '..'
import { openProviderSetupModelEditor } from './ModelEditorModal'
import ProviderCorsConfirmModal from './ProviderCorsConfirmModal'
import { createMount } from './solid-js/mount'
import { ProviderSetup } from './solid-js/Chatbox/components/ProviderSetup'

export default class ProviderEditorModal extends Modal {
	private cleanupModalMount?: () => void
	private destroy?: () => void

	constructor(
		private plugin: NutstorePlugin,
		private provider: AIProviderConfig,
		private onSave: (provider: AIProviderConfig) => Promise<boolean> | boolean,
		private isNew: boolean,
		private readonly mountTarget?: ChatModalMountTarget,
	) {
		super(plugin.app)
		plugin.ai.lifecycle.scope.ownModal(this)
	}

	onOpen() {
		this.setTitle(
			i18n.t(
				this.isNew
					? 'settings.ai.modals.provider.createTitle'
					: 'settings.ai.modals.provider.editTitle',
			),
		)
		addClassTokens(this.modalEl, ':uno: provider-editor-modal', 'mod-lg')
		addClassTokens(this.contentEl, ':uno: provider-editor-modal__content')
		const initialDraft = this.isNew
			? undefined
			: providerToEditorDraft(this.provider)
		const controller = createMount(ProviderSetup, this.contentEl, {
			initialDraft,
			onFetchProviderSetupModels: async (draft) => {
				const models = await fetchProviderModels(
					providerFromEditorDraft(draft, this.provider),
					{
						signal: this.plugin.ai.lifecycle.scope.signal,
					},
				)
				return models.map((model) => model.modelConfig)
			},
			onCreateProviderSetupModel: (id, api) => {
				const preset = resolvePresetModel(id, api)
				return preset
					? { ...preset, id, name: preset.name || id }
					: createModelConfig({ id, name: id }, id)
			},
			onSaveProviderSetup: async (draft) => {
				const provider = providerFromEditorDraft(draft, this.provider)
				if (!(await this.onSave(provider))) return
				new Notice(i18n.t('settings.ai.modals.provider.saved'))
				this.close()
			},
			editor: {
				onCancel: () => this.close(),
				onConfirmCors: () =>
					this.plugin.ai.lifecycle.scope
						.ownModal(new ProviderCorsConfirmModal(this.app, this.mountTarget))
						.openAndWait(),
			},
			onEditModel: (model, save) =>
				openProviderSetupModelEditor(
					this.plugin,
					model,
					save,
					this.mountTarget,
				),
		})
		this.destroy = controller.destroy
	}

	open() {
		super.open()
		this.cleanupModalMount = applyObsidianModalMountTarget(
			this,
			this.mountTarget,
		)
	}

	onClose() {
		this.destroy?.()
		this.destroy = undefined
		this.cleanupModalMount?.()
		this.cleanupModalMount = undefined
		removeClassTokens(this.modalEl, ':uno: provider-editor-modal', 'mod-lg')
		removeClassTokens(this.contentEl, ':uno: provider-editor-modal__content')
		this.contentEl.empty()
	}
}
