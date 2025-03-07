import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import { SelectRemoteBaseDirModal } from './components/SelectRemoteBaseDirModal'
import i18n from './i18n'
import type NutstorePlugin from './index'

export interface NutstoreSettings {
	account: string
	credential: string
	remoteDir: string
	useGitStyle: boolean
	conflictStrategy: 'diff-match-patch' | 'latest-timestamp'
}

export const DEFAULT_SETTINGS: NutstoreSettings = {
	account: '',
	credential: '',
	remoteDir: '',
	useGitStyle: false,
	conflictStrategy: 'diff-match-patch',
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

		await this.displayManualLoginSettings()

		await this.displayCommonSettings()
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
		helper.descEl.innerHTML = `
			<a href="https://help.jianguoyun.com/?p=2064" target="_blank" class="no-underline">
				${i18n.t('settings.help.name')}
			</a>
			`
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
	}
}
