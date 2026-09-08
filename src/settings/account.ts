import { createOAuthUrl } from '@nutstore/sso-js'
import { Notice, Setting } from 'obsidian'
import LogoutConfirmModal from '~/components/LogoutConfirmModal'
import NutstoreEnterpriseBaseUrlModal from '~/components/NutstoreEnterpriseBaseUrlModal'
import i18n from '~/i18n'
import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import { OAuthResponse } from '~/utils/decrypt-ticket-response'
import { is503Error } from '~/utils/is-503-error'
import logger from '~/utils/logger'
import BaseSettings from './settings.base'

export default class AccountSettings extends BaseSettings {
	private updateOAuthUrlTimer: number | null = null

	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.sections.account'))
			.setHeading()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.loginMode.name'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('manual', i18n.t('settings.loginMode.manual'))
					.addOption('sso', i18n.t('settings.loginMode.sso'))
					.setValue(this.plugin.settings.loginMode)
					.onChange(async (value) => {
						this.plugin.settings.loginMode =
							value === 'manual' ? 'manual' : 'sso'
						await this.plugin.settingsService.saveSettings()
						void this.display()
					}),
			)

		if (this.settings.isSSO) {
			await this.displaySSOLoginSettings()
		} else {
			this.displayManualLoginSettings()
		}
	}

	async hide() {
		if (this.updateOAuthUrlTimer !== null) {
			window.clearInterval(this.updateOAuthUrlTimer)
			this.updateOAuthUrlTimer = null
		}
	}

	private displayManualLoginSettings(): void {
		const helper = new Setting(this.containerEl)
		addClassTokens(helper.descEl, ':uno: flex items-center flex-wrap gap-2')
		const anchor = helper.descEl.createEl('a', {
			href: 'https://help.jianguoyun.com/?p=2064',
			cls: ':uno: settings-helper-badge no-underline',
			text: i18n.t('settings.help.name'),
		})
		anchor.target = '_blank'
		const enterpriseAnchor = helper.descEl.createEl('a', {
			href: '#',
			cls: ':uno: settings-helper-badge no-underline',
			text: i18n.t('settings.enterpriseBaseUrl.name'),
		})
		enterpriseAnchor.addEventListener('click', (event) => {
			event.preventDefault()
			new NutstoreEnterpriseBaseUrlModal(this.plugin).open()
		})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.account.name'))
			.setDesc(i18n.t('settings.account.desc'))
			.addText((text) =>
				text
					.setPlaceholder(i18n.t('settings.account.placeholder'))
					.setValue(this.plugin.settings.account)
					.onChange(async (value) => {
						this.plugin.settings.account = value
						await this.plugin.settingsService.saveSettings()
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
						await this.plugin.settingsService.saveSettings()
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
					button.buttonEl.addClass('mod-warning')
					button
						.setButtonText(i18n.t('settings.ssoStatus.logout'))
						.onClick(() => {
							new LogoutConfirmModal(this.app, async () => {
								this.plugin.settings.oauthResponseText = ''
								await this.plugin.settingsService.saveSettings()
								new Notice(i18n.t('settings.ssoStatus.logoutSuccess'))
								void this.display()
							}).open()
						})
				})
			addClassTokens(el.descEl, ':uno: max-w-full', ':uno: truncate')
			addClassTokens(el.infoEl, ':uno: max-w-full')
			this.displayCheckConnection()
		} else {
			new Setting(this.containerEl)
				.setName(i18n.t('settings.ssoStatus.notLoggedIn'))
				.addButton(async (button) => {
					button.setButtonText(i18n.t('settings.login.name'))
					const anchor = createEl('a')
					anchor.target = '_blank'
					button.buttonEl.parentElement?.appendChild(anchor)
					anchor.appendChild(button.buttonEl)
					anchor.href = await createOAuthUrl({
						app: 'obsidian',
					})
					this.updateOAuthUrlTimer = window.setInterval(() => {
						void (async () => {
							const stillInDoc = document.contains(anchor)
							if (stillInDoc) {
								anchor.href = await createOAuthUrl({
									app: 'obsidian',
								})
							} else {
								window.clearInterval(this.updateOAuthUrlTimer!)
								this.updateOAuthUrlTimer = null
							}
						})()
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
						addClassTokens(
							buttonEl,
							':uno: connection-button',
							':uno: loading',
							':uno: opacity-50',
							':uno: pointer-events-none',
						)
						removeClassTokens(buttonEl, ':uno: success', ':uno: error')
						buttonEl.textContent = i18n.t('settings.checkConnection.name')
						try {
							const { success, error } =
								await this.plugin.webDAVService.checkWebDAVConnection()
							removeClassTokens(
								buttonEl,
								':uno: loading',
								':uno: opacity-50',
								':uno: pointer-events-none',
							)
							if (success) {
								addClassTokens(buttonEl, ':uno: success')
								buttonEl.textContent = i18n.t(
									'settings.checkConnection.successButton',
								)
								new Notice(i18n.t('settings.checkConnection.success'))
							} else if (error && is503Error(error)) {
								addClassTokens(buttonEl, ':uno: error')
								buttonEl.textContent = i18n.t('sync.error.requestsTooFrequent')
								new Notice(i18n.t('sync.error.requestsTooFrequent'))
							} else {
								addClassTokens(buttonEl, ':uno: error')
								buttonEl.textContent = i18n.t(
									'settings.checkConnection.failureButton',
								)
								new Notice(i18n.t('settings.checkConnection.failure'))
							}
						} catch {
							removeClassTokens(
								buttonEl,
								':uno: loading',
								':uno: opacity-50',
								':uno: pointer-events-none',
							)
							addClassTokens(buttonEl, ':uno: error')
							buttonEl.textContent = i18n.t(
								'settings.checkConnection.failureButton',
							)
							new Notice(i18n.t('settings.checkConnection.failure'))
						}
					})
			})
	}
}
