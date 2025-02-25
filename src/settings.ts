import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import i18n from './i18n'
import type NutStorePlugin from './index'

export interface NutstoreSettings {
	account: string
	credential: string
	remoteDir: string
	useGitStyle: boolean
}

export const DEFAULT_SETTINGS: NutstoreSettings = {
	account: '',
	credential: '',
	remoteDir: '',
	useGitStyle: false,
}

let pluginInstance: NutStorePlugin | null = null

export function setPluginInstance(plugin: NutStorePlugin | null) {
	pluginInstance = plugin
}

export function useSettings() {
	if (!pluginInstance) {
		throw new Error('Plugin not initialized')
	}
	return pluginInstance.settings
}

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: any // 改为 any 类型避免循环依赖

	constructor(app: App, plugin: any) {
		super(app, plugin)
		this.plugin = plugin
	}

	display(): void {
		const { containerEl } = this

		containerEl.empty()

		containerEl.createEl('h2', { text: i18n.t('settings.title') })

		// 添加备份警告
		new Setting(containerEl)
			.setName(i18n.t('settings.backupWarning.name'))
			.setDesc(i18n.t('settings.backupWarning.desc'))

		new Setting(containerEl)
			.setName(i18n.t('settings.account.name'))
			.setDesc(i18n.t('settings.account.desc'))
			.addText((text) =>
				text
					.setPlaceholder(i18n.t('settings.account.placeholder'))
					.setValue(this.plugin.settings.account)
					.onChange(async (value) => {
						this.plugin.settings.account = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(containerEl)
			.setName(i18n.t('settings.credential.name'))
			.setDesc(i18n.t('settings.credential.desc'))
			.addText((text) => {
				text

					.setPlaceholder(i18n.t('settings.credential.placeholder'))
					.setValue(this.plugin.settings.credential)
					.onChange(async (value) => {
						this.plugin.settings.credential = value
						await this.plugin.saveSettings()
					})
				text.inputEl.type = 'password'
			})

		new Setting(containerEl)
			.setName(i18n.t('settings.remoteDir.name'))
			.setDesc(i18n.t('settings.remoteDir.desc'))
			.addText((text) =>
				text
					.setPlaceholder(i18n.t('settings.remoteDir.placeholder'))
					.setValue(this.plugin.settings.remoteDir)
					.onChange(async (value) => {
						this.plugin.settings.remoteDir = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(containerEl)
			.setName(i18n.t('settings.useGitStyle.name'))
			.setDesc(i18n.t('settings.useGitStyle.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useGitStyle)
					.onChange(async (value) => {
						this.plugin.settings.useGitStyle = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(containerEl)
			.setName(i18n.t('settings.checkConnection.name'))
			.setDesc(i18n.t('settings.checkConnection.desc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.checkConnection.name'))
					.onClick(async () => {
						const isConnected = await this.plugin.checkWebDAVConnection()
						if (isConnected) {
							new Notice(i18n.t('settings.checkConnection.success'))
						} else {
							new Notice(i18n.t('settings.checkConnection.failure'))
						}
					})
			})

		// new Setting(containerEl).addButton((button) => {
		// 	button
		// 		.setButtonText(i18n.t('settings.login.name'))
		// 		.setTooltip(i18n.t('settings.login.desc'))
		// 		.onClick(async () => {
		// 			window.open(
		// 				'https://www.jianguoyun.com/d/openid/auth?client_id=ChBtB1nGO_ZMyq67-d7-mbiNEgQIARAAIiCHytIpw1adUMaa3OQ96gf2BhqyXUgtAnAiHzMFncsSZg&redirect_uri=https%3A%2F%2Fct-pomerium.jianguoyun.net.cn%2Foauth2%2Fcallback&response_type=code&scope=openid+profile+email+offline_access&state=K0ViUVRkUXpRZFVUQVEyUlJoYTh4aUQvY0tvU2J4NFdsb0VVMUR0RTNsbldNdW9MN2pkcEhEa1d6d1piM2JmS0wwVDlUeTA5QnlhZlorREpvZjc0VWc9PXwxNzM5NzU3NzUyfFtPTL0BH3Qh-Xb8QyE-2FeMoCAm1GfdzYVzdEdwKzuWTtnZD-V29UoLoeC2wTQg_tJ2XOZf7KKbEvh73D9YCTfVoDynqqHrMt-VoFl1QqGlQ3JYhZG8RpxTjQveATX-eiFIQNBWwrzwij4s3Su61C5QY5fLmyfPCotZlsWiktUFrQ1S9EKWmRze0LFGRwCBBed-tBGcyTtTAZ9NnDCg9QFQQbLDhIvjwwig6LI4PbvZNcr9P2pOthCd4wj7YzVBnTedsCwCKSIXNzpDJMWFsn1Xkt8oaR0VBdGQ6s046Fu1y4HlUn_0KGX2Vz3VrdlZ8RJMxkesmFiQuOzld_cXK9B4q-enTGHx0Bw5QtcILG-AQiiz-cqzhWYSmh29d_r_uPkproneMuVdNTfUvFt9l8b1hRvMYbFnmBBylWibvO1lhqHWB9DJyk7gOgB7C6Gr5f9vsNhyemn2XKJtM065NBFdLm4iDJS48WHcWbwRShKvXN7E8T6ni_Y8I-fZw_5GepkP5_28p1LhejFfdaCAKbtrsE8Noz1QReHc0vhJHOPESv4LWUFGV91x1NnmkrIqh0JQguJswM6sVQuxy7OHRdDv11lRsCdv8QZl6bfJrAdXaAPiejpEXuq57hXBtIBw0kldynXgd7-PwPFfAiI1vLoIx-ufYU4xvUbtim8xZda2V38obJsENGv5UY7BN7bQZVdER6IkQ6ulXydhk7Eu5Jo9Cnc8nJ4uLfhKH2TlObSlhSCvWsqr',
		// 			)
		// 		})
		// })
	}
}
