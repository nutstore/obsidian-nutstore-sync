import { createOAuthUrl } from '@nutstore/sso-js'
import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import FilterEditorModal from './components/FilterEditorModal'
import LogoutConfirmModal from './components/LogoutConfirmModal'
import SelectRemoteBaseDirModal from './components/SelectRemoteBaseDirModal'
import { onSsoReceive } from './events/sso-receive'
import i18n from './i18n'
import type NutstorePlugin from './index'
import { OAuthResponse } from './utils/decrypt-ticket-response'

export interface NutstoreSettings {
	account: string
	credential: string
	remoteDir: string
	useGitStyle: boolean
	conflictStrategy: 'diff-match-patch' | 'latest-timestamp'
	oauthResponseText: string
	loginMode: 'manual' | 'sso'
	confirmBeforeSync: boolean
	filters: string[]
}

export const DEFAULT_SETTINGS: NutstoreSettings = {
	account: '',
	credential: '',
	remoteDir: '',
	useGitStyle: false,
	conflictStrategy: 'diff-match-patch',
	oauthResponseText: '',
	loginMode: 'sso',
	confirmBeforeSync: true,
	filters: ['.obsidian', '.git', '.DS_Store', '.Trash'],
}

let pluginInstance: NutstorePlugin | null = null

export function setPluginInstance(plugin: NutstorePlugin | null) {
	pluginInstance = plugin
}

export function useSettings() {
	if (!pluginInstance) {
		throw new Error('Plugin not initialized')
	}
	return pluginInstance.settings
}

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: NutstorePlugin

	updateOAuthUrlTimer: number | null = null

	subSso = onSsoReceive().subscribe(() => {
		this.display()
	})

	constructor(app: App, plugin: any) {
		super(app, plugin)
		this.plugin = plugin
	}

	async display() {
		const { containerEl } = this

		containerEl.empty()

		new Setting(containerEl)
			.setName(i18n.t('settings.backupWarning.name'))
			.setDesc(i18n.t('settings.backupWarning.desc'))

		containerEl.createEl('h2', { text: i18n.t('settings.sections.account') })

		new Setting(containerEl)
			.setName(i18n.t('settings.loginMode.name'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('manual', i18n.t('settings.loginMode.manual'))
					.addOption('sso', i18n.t('settings.loginMode.sso'))
					.setValue(this.plugin.settings.loginMode)
					.onChange(async (value: 'manual' | 'sso') => {
						this.plugin.settings.loginMode = value
						await this.plugin.saveSettings()
						this.display()
					}),
			)

		if (this.isSSO) {
			await this.displaySSOLoginSettings()
		} else {
			await this.displayManualLoginSettings()
		}

		await this.displayCommonSettings()
	}

	get isSSO() {
		return this.plugin.settings.loginMode === 'sso'
	}

	private displayCheckConnection() {
		new Setting(this.containerEl)
			.setName(i18n.t('settings.checkConnection.name'))
			.setDesc(i18n.t('settings.checkConnection.desc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.checkConnection.name'))
					.onClick(async (e) => {
						const buttonEl = e.target as HTMLElement
						buttonEl.classList.add('connection-button', 'loading')
						buttonEl.classList.remove('success', 'error')
						buttonEl.textContent = i18n.t('settings.checkConnection.name')
						try {
							const isConnected = await this.plugin.checkWebDAVConnection()
							buttonEl.classList.remove('loading')
							if (isConnected) {
								buttonEl.classList.add('success')
								buttonEl.textContent = i18n.t(
									'settings.checkConnection.successButton',
								)
								new Notice(i18n.t('settings.checkConnection.success'))
							} else {
								buttonEl.classList.add('error')
								buttonEl.textContent = i18n.t(
									'settings.checkConnection.failureButton',
								)
								new Notice(i18n.t('settings.checkConnection.failure'))
							}
						} catch {
							buttonEl.classList.remove('loading')
							buttonEl.classList.add('error')
							buttonEl.textContent = i18n.t(
								'settings.checkConnection.failureButton',
							)
							new Notice(i18n.t('settings.checkConnection.failure'))
						}
					})
			})
	}

	private displayManualLoginSettings(): void {
		const helper = new Setting(this.containerEl)
		const anchor = helper.descEl.createEl('a', {
			href: 'https://help.jianguoyun.com/?p=2064',
			cls: 'no-underline',
			text: i18n.t('settings.help.name'),
		})
		anchor.target = '_blank'

		new Setting(this.containerEl)
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

		new Setting(this.containerEl)
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

		this.displayCheckConnection()
	}

	private async displaySSOLoginSettings() {
		let isLoggedIn = this.plugin.settings.oauthResponseText.length > 0
		let oauth: OAuthResponse | undefined
		if (isLoggedIn) {
			try {
				oauth = await this.plugin.getDecryptedOAuthInfo()
			} catch {
				isLoggedIn = false
			}
		}
		if (isLoggedIn && oauth?.username) {
			const el = new Setting(this.containerEl)
				.setName(i18n.t('settings.ssoStatus.loggedIn'))
				.setDesc(oauth.username)
				.addButton((button) => {
					button
						.setWarning()
						.setButtonText(i18n.t('settings.ssoStatus.logout'))
						.onClick(() => {
							new LogoutConfirmModal(this.app, async () => {
								this.plugin.settings.oauthResponseText = ''
								await this.plugin.saveSettings()
								new Notice(i18n.t('settings.ssoStatus.logoutSuccess'))
								this.display()
							}).open()
						})
				})
			el.descEl.classList.add('max-w-full', 'truncate')
			el.infoEl.classList.add('max-w-full')
			this.displayCheckConnection()
		} else {
			new Setting(this.containerEl)
				.setName(i18n.t('settings.ssoStatus.notLoggedIn'))
				.addButton(async (button) => {
					button.setButtonText(i18n.t('settings.login.name'))
					const anchor = document.createElement('a')
					anchor.target = '_blank'
					button.buttonEl.parentElement?.appendChild(anchor)
					anchor.appendChild(button.buttonEl)
					anchor.href = await createOAuthUrl({
						app: 'obsidian',
					})
					this.updateOAuthUrlTimer = window.setInterval(async () => {
						const stillInDoc = document.contains(anchor)
						if (stillInDoc) {
							anchor.href = await createOAuthUrl({
								app: 'obsidian',
							})
						} else {
							clearInterval(this.updateOAuthUrlTimer!)
							this.updateOAuthUrlTimer = null
						}
					}, 60 * 1000)
				})
		}
	}

	private displayCommonSettings(): void {
		this.containerEl.createEl('h2', {
			text: i18n.t('settings.sections.common'),
		})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.remoteDir.name'))
			.setDesc(i18n.t('settings.remoteDir.desc'))
			.addText((text) => {
				text
					.setPlaceholder(i18n.t('settings.remoteDir.placeholder'))
					.setValue(this.plugin.settings.remoteDir)
					.onChange(async (value) => {
						this.plugin.settings.remoteDir = value
						await this.plugin.saveSettings()
					})
			})
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.remoteDir.edit')).onClick(() => {
					new SelectRemoteBaseDirModal(this.app, this.plugin, async (path) => {
						this.plugin.settings.remoteDir = path
						await this.plugin.saveSettings()
						this.display()
					}).open()
				})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.conflictStrategy.name'))
			.setDesc(i18n.t('settings.conflictStrategy.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						'diff-match-patch',
						i18n.t('settings.conflictStrategy.diffMatchPatch'),
					)
					.addOption(
						'latest-timestamp',
						i18n.t('settings.conflictStrategy.latestTimestamp'),
					)
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value: 'diff-match-patch' | 'latest-timestamp') => {
						this.plugin.settings.conflictStrategy = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(this.containerEl)
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

		new Setting(this.containerEl)
			.setName(i18n.t('settings.confirmBeforeSync.name'))
			.setDesc(i18n.t('settings.confirmBeforeSync.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.confirmBeforeSync)
					.onChange(async (value) => {
						this.plugin.settings.confirmBeforeSync = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(this.containerEl)
			.setName(i18n.t('settings.filters.name'))
			.setDesc(i18n.t('settings.filters.desc'))
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.filters.edit')).onClick(() => {
					new FilterEditorModal(
						this.app,
						this.plugin.settings.filters,
						async (filters) => {
							this.plugin.settings.filters = filters
							await this.plugin.saveSettings()
							this.display()
						},
					).open()
				})
			})
	}

	hide() {
		if (this.updateOAuthUrlTimer !== null) {
			clearInterval(this.updateOAuthUrlTimer)
			this.updateOAuthUrlTimer = null
		}
	}
}
