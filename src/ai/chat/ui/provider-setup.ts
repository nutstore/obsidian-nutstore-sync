import type { ChatProviderOption, ProviderSetupState } from '~/ai/chat/ui/types'

/**
 * Provider onboarding owns the chatbox until at least one usable model exists.
 * It is an application-level prerequisite, not a state of the empty timeline.
 */
export function resolveProviderSetupState(
	providers: ChatProviderOption[],
	loading: boolean,
): ProviderSetupState | undefined {
	if (loading) return undefined
	if (providers.length === 0) return { kind: 'no-provider' }
	if (providers.some((provider) => provider.models.length > 0)) return undefined

	const provider = providers[0]
	return {
		kind: 'no-model',
		providerId: provider.id,
		providerName: provider.name,
	}
}
