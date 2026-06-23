import { Notice } from 'obsidian'
import {
	getFirstModel,
	getModelById,
	getProviderById,
	resolveInitialSelection,
} from '~/ai/catalog/config'
import { assertProviderUsable } from '~/ai/core/runtime'
import type { AIProviderConfig, AISession } from '~/ai/core/types'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import type NutstorePlugin from '../../..'

export interface ModelDescriptor {
	id: string
	name?: string
}

export class Selection {
	constructor(
		private plugin: NutstorePlugin,
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private notify: () => void,
		private persistSession: (session: AISession) => Promise<void>,
	) {}

	getLoadedActiveSession() {
		return this.state.activeSessionId
			? this.state.loadedSessions.get(this.state.activeSessionId)
			: undefined
	}

	selectProvider(providerId: string) {
		const session = this.getLoadedActiveSession()
		if (!session) {
			if (!providerId) {
				this.state.pendingProviderId = undefined
				this.state.pendingModelId = undefined
				this.notify()
				return
			}

			const provider = getProviderById(
				this.plugin.settings.ai.providers,
				providerId,
			)
			if (!provider) {
				return
			}

			this.state.pendingProviderId = provider.id
			this.state.pendingModelId = getFirstModel(provider)?.id
			this.notify()
			return
		}

		if (this.runtimeStates.get(session.id).runState !== 'idle') {
			return
		}
		if (!providerId) {
			session.model = undefined
			void this.persistSession(session)
			this.notify()
			return
		}

		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			providerId,
		)
		if (!provider) {
			return
		}

		const firstModelId = getFirstModel(provider)?.id
		session.model = firstModelId
			? { providerId: provider.id, modelId: firstModelId }
			: undefined
		void this.persistSession(session)
		this.notify()
	}

	selectModel(modelId: string) {
		const session = this.getLoadedActiveSession()
		if (!session) {
			if (!modelId) {
				this.state.pendingModelId = undefined
				this.notify()
				return
			}

			const provider = getProviderById(
				this.plugin.settings.ai.providers,
				this.state.pendingProviderId,
			)
			const model = getModelById(provider, modelId)
			if (!model) {
				return
			}

			this.state.pendingModelId = model.id
			this.notify()
			return
		}

		if (this.runtimeStates.get(session.id).runState !== 'idle') {
			return
		}
		if (!modelId) {
			session.model = undefined
			void this.persistSession(session)
			this.notify()
			return
		}

		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			session.model?.providerId,
		)
		const model = getModelById(provider, modelId)
		if (!model || !provider) {
			return
		}

		session.model = { providerId: provider.id, modelId: model.id }
		void this.persistSession(session)
		this.notify()
	}

	sanitizeSessionSelection(session: AISession) {
		if (!session.model) {
			if (this.sessionHasMessages(session)) {
				return false
			}

			const fallbackSelection = resolveInitialSelection(
				this.plugin.settings.ai.providers,
				this.plugin.settings.ai.defaultModel,
			)
			const fallbackProvider = getProviderById(
				this.plugin.settings.ai.providers,
				fallbackSelection.providerId,
			)
			const fallbackModel = getModelById(
				fallbackProvider,
				fallbackSelection.modelId,
			)
			if (!fallbackProvider || !fallbackModel) {
				return false
			}

			session.model = {
				providerId: fallbackProvider.id,
				modelId: fallbackModel.id,
			}
			return true
		}

		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			session.model?.providerId,
		)
		if (!provider) {
			session.model = undefined
			return true
		}

		const nextModelId =
			getModelById(provider, session.model?.modelId)?.id ||
			getFirstModel(provider)?.id
		const nextModel = nextModelId
			? { providerId: provider.id, modelId: nextModelId }
			: undefined
		const changed =
			session.model?.providerId !== provider.id ||
			session.model?.modelId !== nextModelId
		session.model = nextModel
		return changed
	}

	sessionHasMessages(session: AISession) {
		return session.fragments.some((fragment) => fragment.messages.length > 0)
	}

	getInitialSelectionForNewSession() {
		const emptyStateSelection = this.getEmptyStateSelection()
		return {
			providerId: emptyStateSelection.providerId,
			modelId: emptyStateSelection.modelId,
		}
	}

	getEmptyStateSelection() {
		const defaults = resolveInitialSelection(
			this.plugin.settings.ai.providers,
			this.plugin.settings.ai.defaultModel,
		)
		const provider =
			getProviderById(
				this.plugin.settings.ai.providers,
				this.state.pendingProviderId,
			) ||
			getProviderById(this.plugin.settings.ai.providers, defaults.providerId)
		const model =
			getModelById(provider, this.state.pendingModelId) ||
			getModelById(provider, defaults.modelId) ||
			getFirstModel(provider)

		return {
			providerId: provider?.id,
			modelId: model?.id,
		}
	}

	syncPendingSelectionWithSettings() {
		const defaults = resolveInitialSelection(
			this.plugin.settings.ai.providers,
			this.plugin.settings.ai.defaultModel,
		)
		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			defaults.providerId,
		)
		const model =
			getModelById(provider, defaults.modelId) || getFirstModel(provider)
		this.state.pendingProviderId = provider?.id
		this.state.pendingModelId = model?.id
	}

	validateSessionSelection(session: AISession) {
		try {
			const provider = this.getProviderOrThrow(session)
			this.getModelOrThrow(provider, session)
			return true
		} catch (error) {
			const message =
				error instanceof Error ? error.message : i18n.t('chatbox.requestFailed')
			logger.error(error)
			new Notice(message)
			return false
		}
	}

	requireProvider(id: string | undefined): AIProviderConfig {
		const provider = getProviderById(this.plugin.settings.ai.providers, id)
		if (!provider) throw new Error(i18n.t('chatbox.errors.noProvider'))
		assertProviderUsable(provider)
		return provider
	}

	requireModel(provider: AIProviderConfig, id: string | undefined) {
		const model = getModelById(provider, id)
		if (!model) throw new Error(i18n.t('chatbox.errors.noModel'))
		return model
	}

	getProviderOrThrow(session: AISession) {
		return this.requireProvider(session.model?.providerId)
	}

	getProviderByIdOrThrow(id: string) {
		return this.requireProvider(id)
	}

	getModelOrThrow(provider: AIProviderConfig, session: AISession) {
		return this.requireModel(provider, session.model?.modelId)
	}

	getModelByIdsOrThrow(provider: AIProviderConfig, id: string) {
		return this.requireModel(provider, id)
	}
}
