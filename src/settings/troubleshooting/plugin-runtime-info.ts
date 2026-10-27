import { apiVersion, Platform, setIcon } from 'obsidian'
import { CHATBOX_AI_ICON_ID } from '~/assets/icons/obsidian-nutstore-ai-icon'
import i18n from '~/i18n'
import { getWebviewRuntimeInfo } from '~/utils/webview-runtime-info'
import BaseSettings from '../settings.base'

export default class PluginRuntimeInfoSettings extends BaseSettings {
	readonly name = () => i18n.t('settings.troubleshooting.pluginInfo')
	readonly searchable = false
	readonly showGroupHeading = false

	getSearchTerms(): string[] {
		return []
	}

	async display() {
		this.containerEl.empty()
		const card = this.containerEl.createDiv({ cls: 'nutstore-plugin-info' })
		const header = card.createDiv({ cls: 'nutstore-plugin-info__header' })
		const icon = header.createDiv({ cls: 'nutstore-plugin-info__icon' })
		icon.setAttribute('aria-hidden', 'true')
		setIcon(icon, CHATBOX_AI_ICON_ID)
		const identity = header.createDiv({ cls: 'nutstore-plugin-info__identity' })
		identity.createDiv({
			cls: 'nutstore-plugin-info__name',
			text: this.plugin.manifest.name,
		})
		identity.createDiv({
			cls: 'nutstore-plugin-info__version',
			text: `v${this.plugin.manifest.version}`,
		})

		const details = card.createEl('dl', {
			cls: 'nutstore-plugin-info__details',
		})
		const { runtime, userAgent } = getWebviewRuntimeInfo()
		const fields = [
			['Obsidian', apiVersion],
			[i18n.t('settings.troubleshooting.platform'), this.platformName],
			[
				i18n.t('settings.troubleshooting.language'),
				i18n.resolvedLanguage === 'zh' ? '简体中文' : 'English',
			],
			[
				i18n.t('settings.troubleshooting.webviewRuntime'),
				runtime ?? i18n.t('settings.troubleshooting.unknownRuntime'),
			],
		]
		for (const [label, value] of fields) {
			const field = details.createDiv({ cls: 'nutstore-plugin-info__field' })
			field.createEl('dt', { text: label })
			field.createEl('dd', { text: value })
		}
		const userAgentDetails = card.createEl('details', {
			cls: 'nutstore-plugin-info__ua',
		})
		userAgentDetails.createEl('summary', { text: 'User agent' })
		userAgentDetails.createEl('p', { text: userAgent })
	}

	private get platformName() {
		if (Platform.isIosApp) return 'iOS'
		if (Platform.isAndroidApp) return 'Android'
		if (Platform.isMacOS) return 'macOS'
		if (Platform.isWin) return 'Windows'
		if (Platform.isLinux) return 'Linux'
		return i18n.t('settings.troubleshooting.unknownPlatform')
	}
}
