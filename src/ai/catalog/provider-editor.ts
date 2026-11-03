import { cloneDeep } from 'es-toolkit/compat'
import type { ChatProviderSetupDraft } from '~/ai/chat/ui/types'
import type { AIProviderConfig } from '~/ai/core/types'
import { createProviderConfig, slugifyProviderId } from './config'

export function providerToEditorDraft(
	provider: AIProviderConfig,
): ChatProviderSetupDraft {
	return {
		existingProviderId: provider.id,
		env: [...provider.env],
		doc: provider.doc,
		name: provider.name,
		npm: provider.npm,
		api: provider.api,
		apiKey: provider.apiKey,
		allowBrowserCors: !!provider.allowBrowserCors,
		models: cloneDeep(provider.models),
	}
}

export function providerFromEditorDraft(
	draft: ChatProviderSetupDraft,
	existing?: AIProviderConfig,
): AIProviderConfig {
	const id = draft.existingProviderId?.trim() || slugifyProviderId(draft.name)
	return createProviderConfig(
		{
			...existing,
			...draft,
			env: draft.env ?? existing?.env,
			doc: draft.doc ?? existing?.doc,
			id,
		},
		id,
	)
}
