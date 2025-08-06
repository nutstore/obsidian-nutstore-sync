import { Setting } from 'obsidian'
import SelectRemoteBaseDirModal from '~/components/SelectRemoteBaseDirModal'
import i18n from '~/i18n'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { SyncMode } from './index'
import BaseSettings from './settings.base'

export default class CommonSettings extends BaseSettings {
	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.sections.common'))
			.setHeading()

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
						ConflictStrategy.DiffMatchPatch,
						i18n.t('settings.conflictStrategy.diffMatchPatch'),
					)
					.addOption(
						ConflictStrategy.LatestTimeStamp,
						i18n.t('settings.conflictStrategy.latestTimestamp'),
					)
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value: ConflictStrategy) => {
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
			.setName(i18n.t('settings.startupSyncDelay.name'))
			.setDesc(i18n.t('settings.startupSyncDelay.desc'))
			.addText((text) => {
				text
					.setPlaceholder(i18n.t('settings.startupSyncDelay.placeholder'))
					.setValue(this.plugin.settings.startupSyncDelaySeconds.toString())
					.onChange(async (value) => {
						const numValue = parseFloat(value)
						if (!isNaN(numValue)) {
							this.plugin.settings.startupSyncDelaySeconds = numValue
							await this.plugin.saveSettings()
						}
					})
				text.inputEl.addEventListener('blur', () => {
					const value = text.getValue()
					const numValue = parseFloat(value)
					if (Number.isNaN(numValue) || numValue < 0) {
						text.setValue('0')
					} else {
						text.setValue(numValue.toString())
					}
				})
				text.inputEl.type = 'number'
				text.inputEl.min = '0'
			})

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
			.setName(i18n.t('settings.autoSyncInterval.name'))
			.setDesc(i18n.t('settings.autoSyncInterval.desc'))
			.addText((text) => {
				text
					.setPlaceholder(i18n.t('settings.autoSyncInterval.placeholder'))
					.setValue(
						Math.round(
							this.plugin.settings.autoSyncIntervalSeconds / 60,
						).toString(),
					)
					.onChange(async (value) => {
						const numValue = parseFloat(value)
						if (!isNaN(numValue) && numValue > 0) {
							this.plugin.settings.autoSyncIntervalSeconds = numValue * 60
							await this.plugin.saveSettings()
							await this.plugin.autoSyncService.updateInterval()
						}
					})
				text.inputEl.addEventListener('blur', async () => {
					const value = text.getValue()
					const numValue = parseFloat(value)
					if (Number.isNaN(numValue) || numValue <= 0) {
						text.setValue('1')
						this.plugin.settings.autoSyncIntervalSeconds = 60
						await this.plugin.saveSettings()
						await this.plugin.autoSyncService.updateInterval()
					} else {
						text.setValue(Math.round(numValue).toString())
						this.plugin.settings.autoSyncIntervalSeconds =
							Math.round(numValue) * 60
						await this.plugin.saveSettings()
						await this.plugin.autoSyncService.updateInterval()
					}
				})
				text.inputEl.type = 'number'
				text.inputEl.min = '1'
				text.inputEl.step = '1'
			})
	}
}
