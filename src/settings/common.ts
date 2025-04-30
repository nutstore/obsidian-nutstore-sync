import { Setting } from 'obsidian'
import FilterEditorModal from '~/components/FilterEditorModal'
import SelectRemoteBaseDirModal from '~/components/SelectRemoteBaseDirModal'
import i18n from '~/i18n'
import { SyncMode } from './index'
import BaseSettings from './settings.base'

export default class CommonSettings extends BaseSettings {
	async display() {
		this.containerEl.empty()
		this.containerEl.createEl('h2', {
			text: i18n.t('settings.sections.common'),
		})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.remoteDir.name'))
			.setDesc(i18n.t('settings.remoteDir.desc'))
			.addText((text) => {
				text
					.setPlaceholder(i18n.t('settings.remoteDir.placeholder'))
					.setValue(this.plugin.remoteBaseDir)
					.onChange(async (value) => {
						this.plugin.settings.remoteDir = value
						await this.plugin.saveSettings()
					})
				text.inputEl.addEventListener('blur', () => {
					this.plugin.settings.remoteDir = this.plugin.remoteBaseDir
					this.display()
				})
			})
			.addButton((button) => {
				button.setIcon('folder').onClick(() => {
					new SelectRemoteBaseDirModal(this.app, this.plugin, async (path) => {
						this.plugin.settings.remoteDir = path
						await this.plugin.saveSettings()
						this.display()
					}).open()
				})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.skipLargeFiles.name'))
			.setDesc(i18n.t('settings.skipLargeFiles.desc'))
			.addText((text) => {
				const currentValue = this.plugin.settings.skipLargeFiles.maxSize.trim()
				text
					.setPlaceholder(i18n.t('settings.skipLargeFiles.placeholder'))
					.setValue(currentValue)
					.onChange(async (value) => {
						this.plugin.settings.skipLargeFiles.maxSize = value.trim()
						await this.plugin.saveSettings()
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
			.setName(i18n.t('settings.realtimeSync.name'))
			.setDesc(i18n.t('settings.realtimeSync.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.realtimeSync)
					.onChange(async (value) => {
						this.plugin.settings.realtimeSync = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(this.containerEl)
			.setName(i18n.t('settings.syncMode.name'))
			.setDesc(i18n.t('settings.syncMode.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption(SyncMode.STRICT, i18n.t('settings.syncMode.strict'))
					.addOption(SyncMode.LOOSE, i18n.t('settings.syncMode.loose'))
					.setValue(this.plugin.settings.syncMode)
					.onChange(async (value: string) => {
						this.plugin.settings.syncMode = value as SyncMode
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
}
