import { createOAuthUrl } from '@nutstore/sso-js'
import { Notice, Setting } from 'obsidian'
import LogoutConfirmModal from '~/components/LogoutConfirmModal'
import i18n from '~/i18n'
import { OAuthResponse } from '~/utils/decrypt-ticket-response'
import logger from '~/utils/logger'
import BaseSettings from './settings.base'

export default class AccountSettings extends BaseSettings {
	private updateOAuthUrlTimer: number | null = null

	async display() {
		this.containerEl.empty()
		this.containerEl.createEl('h2', {
			text: i18n.t('settings.sections.account'),
		})

		new Setting(this.containerEl)
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

		if (this.settings.isSSO) {
			await this.displaySSOLoginSettings()
		} else {
			await this.displayManualLoginSettings()
		}
	}

	async hide() {
		if (this.updateOAuthUrlTimer !== null) {
			clearInterval(this.updateOAuthUrlTimer)
			this.updateOAuthUrlTimer = null
		}
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
			} catch (e) {
				logger.error(e)
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
}
