import { parse as bytesParse } from 'bytes-iec'
import { clamp, isNil } from 'lodash-es'
import { Notice, Setting, TextComponent } from 'obsidian'
import { isNotNil } from 'ramda'
import SelectRemoteBaseDirModal from '~/components/SelectRemoteBaseDirModal'
import i18n from '~/i18n'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { isNumeric } from '~/utils/is-numeric'
import { SyncMode } from './index'
import BaseSettings from './settings.base'

/**
 * https://help.jianguoyun.com/?p=2064
 */
const MAX_FILE_SIZE = '500MB'
const MAX_BYTES = bytesParse(MAX_FILE_SIZE, { mode: 'jedec' })!

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

				text.inputEl.addEventListener('blur', () => {
					this.handleMaxFileSizeBlur(text)
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
					.addOption(
						ConflictStrategy.Skip,
						i18n.t('settings.conflictStrategy.skip'),
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
			.setName(i18n.t('settings.confirmBeforeDeleteInAutoSync.name'))
			.setDesc(i18n.t('settings.confirmBeforeDeleteInAutoSync.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.confirmBeforeDeleteInAutoSync)
					.onChange(async (value) => {
						this.plugin.settings.confirmBeforeDeleteInAutoSync = value
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
				const MAX_SECONDS = 86400 // 1 day
				text
					.setPlaceholder(i18n.t('settings.startupSyncDelay.placeholder'))
					.setValue(this.plugin.settings.startupSyncDelaySeconds.toString())
					.onChange(async (value) => {
						const numValue = parseFloat(value)
						if (!isNaN(numValue)) {
							const clampedValue = clamp(numValue, 0, MAX_SECONDS)
							this.plugin.settings.startupSyncDelaySeconds = clampedValue
							await this.plugin.saveSettings()
							if (clampedValue !== numValue) {
								new Notice(
									i18n.t('settings.startupSyncDelay.exceedsMax', {
										max: MAX_SECONDS,
									}),
								)
								text.setValue(clampedValue.toString())
							}
						}
					})
				text.inputEl.addEventListener('blur', async () => {
					const numValue = parseFloat(text.getValue())
					const finalValue = isNaN(numValue)
						? 0
						: clamp(numValue, 0, MAX_SECONDS)

					if (isNaN(numValue)) {
						new Notice(i18n.t('settings.startupSyncDelay.invalidValue'))
					} else if (finalValue !== numValue) {
						new Notice(
							i18n.t('settings.startupSyncDelay.exceedsMax', {
								max: MAX_SECONDS,
							}),
						)
					}

					text.setValue(finalValue.toString())
					this.plugin.settings.startupSyncDelaySeconds = finalValue
					await this.plugin.saveSettings()
				})
				text.inputEl.type = 'number'
				text.inputEl.min = '0'
				text.inputEl.max = MAX_SECONDS.toString()
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.autoSyncInterval.name'))
			.setDesc(i18n.t('settings.autoSyncInterval.desc'))
			.addText((text) => {
				const MAX_MINUTES = 1440 // 1 day
				text
					.setPlaceholder(i18n.t('settings.autoSyncInterval.placeholder'))
					.setValue(
						Math.round(
							this.plugin.settings.autoSyncIntervalSeconds / 60,
						).toString(),
					)
					.onChange(async (value) => {
						const numValue = parseFloat(value)
						if (!isNaN(numValue)) {
							const clampedValue = clamp(numValue, 0, MAX_MINUTES)
							this.plugin.settings.autoSyncIntervalSeconds = clampedValue * 60
							await this.plugin.saveSettings()
							await this.plugin.scheduledSyncService.updateInterval()
							if (clampedValue !== numValue) {
								new Notice(
									i18n.t('settings.autoSyncInterval.exceedsMax', {
										max: MAX_MINUTES,
									}),
								)
								text.setValue(clampedValue.toString())
							}
						}
					})
				text.inputEl.addEventListener('blur', async () => {
					const numValue = parseFloat(text.getValue())
					const finalValue = isNaN(numValue)
						? 0
						: Math.round(clamp(numValue, 0, MAX_MINUTES))
					text.setValue(finalValue.toString())

					if (isNaN(numValue)) {
						new Notice(i18n.t('settings.autoSyncInterval.invalidValue'))
					} else if (finalValue !== numValue) {
						new Notice(
							i18n.t('settings.autoSyncInterval.exceedsMax', {
								max: MAX_MINUTES,
							}),
						)
					}

					this.plugin.settings.autoSyncIntervalSeconds = finalValue * 60
					await this.plugin.saveSettings()
					await this.plugin.scheduledSyncService.updateInterval()
				})
				text.inputEl.type = 'number'
				text.inputEl.min = '0'
				text.inputEl.max = MAX_MINUTES.toString()
				text.inputEl.step = '1'
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
			.setName(i18n.t('settings.language.name'))
			.setDesc(i18n.t('settings.language.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('', i18n.t('settings.language.auto'))
					.addOption('zh', '简体中文')
					.addOption('en', 'English')
					.setValue(this.plugin.settings.language || '')
					.onChange(async (value: string) => {
						if (
							value === 'zh' ||
							value === 'en' ||
							value === '' ||
							isNil(value)
						) {
							this.plugin.settings.language = value || undefined
							await this.plugin.saveSettings()
							await this.plugin.i18nService.update()
							await this.settings.display()
						}
					}),
			)
	}

	private async handleMaxFileSizeBlur(component: TextComponent) {
		let value = component.getValue().trim()
		// Empty value: restore to default max size
		if (!value) {
			value = MAX_FILE_SIZE
		}
		// Plain number without unit: append 'B' for better UX
		else if (
			isNumeric(value) ||
			(isNil(bytesParse(value)) && isNotNil(bytesParse(value + 'B')))
		) {
			value += 'B'
		}
		// Validate the input format
		const parsedBytes = bytesParse(value, { mode: 'jedec' })
		// Invalid format (e.g., "100FOO"): show error and revert to last saved value
		if (parsedBytes === null) {
			new Notice(i18n.t('settings.skipLargeFiles.invalidFormat'))
			component.setValue(this.plugin.settings.skipLargeFiles.maxSize)
			return
		}
		// Exceeds max limit (e.g., "1GB"): show error and clamp to max allowed value
		if (parsedBytes > MAX_BYTES) {
			new Notice(i18n.t('settings.skipLargeFiles.exceedsMaxSize'))
			value = MAX_FILE_SIZE
		}
		// Update UI with formatted value to ensure consistency
		component.setValue(value)
		// Save to disk only if value actually changed
		if (this.plugin.settings.skipLargeFiles.maxSize !== value) {
			this.plugin.settings.skipLargeFiles.maxSize = value
			await this.plugin.saveSettings()
		}
	}
}
