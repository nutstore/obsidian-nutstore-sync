import { Notice } from 'obsidian'
import { getProviderById } from '~/ai/config'
import ProviderEditorModal from '~/components/ProviderEditorModal'
import { emitSsoReceive } from '~/events/sso-receive'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

export default class ProtocolService {
	constructor(private plugin: NutstorePlugin) {
		this.plugin.registerObsidianProtocolHandler(
			'nutstore-sync/sso',
			async (data) => {
				if (data?.s) {
					this.plugin.settings.oauthResponseText = data.s
					await this.plugin.settingsService.saveSettings()
					new Notice(i18n.t('settings.login.success'), 5000)
				}
				emitSsoReceive({
					token: data?.s,
				})
			},
		)

		this.plugin.registerObsidianProtocolHandler(
			'nutstore-sync/modal/provider-edit',
			async (data) => {
				const providerId =
					typeof data?.providerId === 'string' ? data.providerId.trim() : ''
				if (!providerId) {
					return
				}
				await this.openProviderEditor(providerId)
			},
		)
	}

	async openProviderEditor(providerId: string) {
		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			providerId,
		)
		if (!provider) {
			logger.warn(`Provider not found for protocol open: ${providerId}`)
			new Notice(
				i18n.t('settings.ai.errors.providerNotFoundForProtocolOpen', {
					providerId,
				}),
			)
			return
		}

		new ProviderEditorModal(
			this.plugin,
			provider,
			async (savedProvider) => {
				this.plugin.settings.ai.providers = {
					...this.plugin.settings.ai.providers,
					[providerId]: savedProvider,
				}
				await this.plugin.settingsService.saveSettings()
				return true
			},
			false,
		).open()
	}
}
