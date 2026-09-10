import { clamp } from 'es-toolkit/compat'
import { Notice, Setting } from 'obsidian'
import i18n from '~/i18n'
import BaseSettings from '../settings.base'

const MAX_STARTUP_DELAY_SECONDS = 86400
const MAX_AUTO_SYNC_INTERVAL_MINUTES = 1440

/** Settings that determine when synchronization runs without user action. */
export default class AutomationSettings extends BaseSettings {
	readonly name = () => i18n.t('settings.sections.automation')
	readonly showGroupHeading = true

	getSearchTerms(): string[] {
		return [
			i18n.t('settings.realtimeSync.name'),
			i18n.t('settings.realtimeSync.desc'),
			i18n.t('settings.startupSyncDelay.name'),
			i18n.t('settings.startupSyncDelay.desc'),
			i18n.t('settings.autoSyncInterval.name'),
			i18n.t('settings.autoSyncInterval.desc'),
		]
	}

	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.realtimeSync.name'))
			.setDesc(i18n.t('settings.realtimeSync.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.realtimeSync)
					.onChange(async (value) => {
						this.plugin.settings.realtimeSync = value
						await this.plugin.settingsService.saveSettings()
					}),
			)

		this.addStartupDelay()
		this.addAutoSyncInterval()
	}

	private addStartupDelay() {
		new Setting(this.containerEl)
			.setName(i18n.t('settings.startupSyncDelay.name'))
			.setDesc(i18n.t('settings.startupSyncDelay.desc'))
			.addText((text) => {
				text
					.setPlaceholder(i18n.t('settings.startupSyncDelay.placeholder'))
					.setValue(this.plugin.settings.startupSyncDelaySeconds.toString())
					.onChange(async (value) => {
						const input = parseFloat(value)
						if (isNaN(input)) return
						const seconds = clamp(input, 0, MAX_STARTUP_DELAY_SECONDS)
						this.plugin.settings.startupSyncDelaySeconds = seconds
						await this.plugin.settingsService.saveSettings()
						if (seconds !== input) {
							new Notice(
								i18n.t('settings.startupSyncDelay.exceedsMax', {
									max: MAX_STARTUP_DELAY_SECONDS,
								}),
							)
							text.setValue(seconds.toString())
						}
					})
				text.inputEl.addEventListener('blur', () => {
					void this.saveStartupDelay(text.getValue(), (value) => {
						text.setValue(value)
					})
				})
				text.inputEl.type = 'number'
				text.inputEl.min = '0'
				text.inputEl.max = MAX_STARTUP_DELAY_SECONDS.toString()
			})
	}

	private async saveStartupDelay(
		value: string,
		setValue: (value: string) => void,
	) {
		const input = parseFloat(value)
		const seconds = isNaN(input)
			? 0
			: clamp(input, 0, MAX_STARTUP_DELAY_SECONDS)
		if (isNaN(input)) {
			new Notice(i18n.t('settings.startupSyncDelay.invalidValue'))
		} else if (seconds !== input) {
			new Notice(
				i18n.t('settings.startupSyncDelay.exceedsMax', {
					max: MAX_STARTUP_DELAY_SECONDS,
				}),
			)
		}
		setValue(seconds.toString())
		this.plugin.settings.startupSyncDelaySeconds = seconds
		await this.plugin.settingsService.saveSettings()
	}

	private addAutoSyncInterval() {
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
						const input = parseFloat(value)
						if (isNaN(input)) return
						const minutes = clamp(input, 0, MAX_AUTO_SYNC_INTERVAL_MINUTES)
						await this.saveAutoSyncInterval(minutes)
						if (minutes !== input) {
							new Notice(
								i18n.t('settings.autoSyncInterval.exceedsMax', {
									max: MAX_AUTO_SYNC_INTERVAL_MINUTES,
								}),
							)
							text.setValue(minutes.toString())
						}
					})
				text.inputEl.addEventListener('blur', () => {
					void this.saveAutoSyncIntervalOnBlur(text.getValue(), (value) => {
						text.setValue(value)
					})
				})
				text.inputEl.type = 'number'
				text.inputEl.min = '0'
				text.inputEl.max = MAX_AUTO_SYNC_INTERVAL_MINUTES.toString()
				text.inputEl.step = '1'
			})
	}

	private async saveAutoSyncIntervalOnBlur(
		value: string,
		setValue: (value: string) => void,
	) {
		const input = parseFloat(value)
		const minutes = isNaN(input)
			? 0
			: Math.round(clamp(input, 0, MAX_AUTO_SYNC_INTERVAL_MINUTES))
		if (isNaN(input)) {
			new Notice(i18n.t('settings.autoSyncInterval.invalidValue'))
		} else if (minutes !== input) {
			new Notice(
				i18n.t('settings.autoSyncInterval.exceedsMax', {
					max: MAX_AUTO_SYNC_INTERVAL_MINUTES,
				}),
			)
		}
		setValue(minutes.toString())
		await this.saveAutoSyncInterval(minutes)
	}

	private async saveAutoSyncInterval(minutes: number) {
		this.plugin.settings.autoSyncIntervalSeconds = minutes * 60
		await this.plugin.settingsService.saveSettings()
		await this.plugin.scheduledSyncService.updateInterval()
	}
}
