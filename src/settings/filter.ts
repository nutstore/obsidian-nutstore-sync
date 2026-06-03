import { App, Modal, Setting } from 'obsidian'
import FilterEditorModal from '~/components/FilterEditorModal'
import i18n from '~/i18n'
import BaseSettings from './settings.base'

type ConfigDirSyncMode = 'none' | 'bookmarks' | 'all'

function isConfigDirSyncMode(value: string): value is ConfigDirSyncMode {
	return value === 'none' || value === 'bookmarks' || value === 'all'
}

export default class FilterSettings extends BaseSettings {
	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.sections.filters'))
			.setHeading()

		const configDir = this.plugin.app.vault.configDir

		new Setting(this.containerEl)
			.setName(i18n.t('settings.configDirSync.name'))
			.setDesc(i18n.t('settings.configDirSync.desc', { configDir }))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('none', i18n.t('settings.configDirSync.none'))
					.addOption('bookmarks', i18n.t('settings.configDirSync.bookmarks'))
					.addOption('all', i18n.t('settings.configDirSync.all'))
					.setValue(this.plugin.settings.configDirSyncMode ?? 'none')
					.onChange(async (value: string) => {
						if (!isConfigDirSyncMode(value)) {
							return
						}
						if (value === 'bookmarks') {
							new ConfigDirSyncBookmarksModal(
								this.app,
								configDir,
								async (confirmed) => {
									if (confirmed) {
										this.plugin.settings.configDirSyncMode = 'bookmarks'
										await this.plugin.saveSettings()
									} else {
										this.display()
									}
								},
							).open()
						} else if (value === 'all') {
							new ConfigDirSyncWarningModal(
								this.app,
								configDir,
								async (confirmed) => {
									if (confirmed) {
										this.plugin.settings.configDirSyncMode = 'all'
										await this.plugin.saveSettings()
									} else {
										this.display()
									}
								},
							).open()
						} else {
							this.plugin.settings.configDirSyncMode = value
							await this.plugin.saveSettings()
						}
					}),
			)

		// Inclusion
		new Setting(this.containerEl)
			.setName(i18n.t('settings.filters.include.name'))
			.setDesc(i18n.t('settings.filters.include.desc'))
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.filters.edit')).onClick(() => {
					new FilterEditorModal(
						this.plugin,
						this.plugin.settings.filterRules.inclusionRules,
						async (filters) => {
							this.plugin.settings.filterRules.inclusionRules = filters
							await this.plugin.saveSettings()
							this.display()
						},
						FilterEditorModal.FilterType.Include,
					).open()
				})
			})

		// Exclusion
		new Setting(this.containerEl)
			.setName(i18n.t('settings.filters.exclude.name'))
			.setDesc(i18n.t('settings.filters.exclude.desc'))
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.filters.edit')).onClick(() => {
					new FilterEditorModal(
						this.plugin,
						this.plugin.settings.filterRules.exclusionRules,
						async (filters) => {
							this.plugin.settings.filterRules.exclusionRules = filters
							await this.plugin.saveSettings()
							this.display()
						},
						FilterEditorModal.FilterType.Exclude,
					).open()
				})
			})
	}
}

class ConfigDirSyncBookmarksModal extends Modal {
	constructor(
		app: App,
		private configDir: string,
		private onResult: (confirmed: boolean) => void,
	) {
		super(app)
	}

	onOpen() {
		const { contentEl } = this
		contentEl.createEl('h2', {
			text: i18n.t('settings.configDirSync.bookmarksTitle'),
		})
		contentEl.createEl('p', {
			text: i18n.t('settings.configDirSync.bookmarksDesc', {
				configDir: this.configDir,
			}),
		})
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(i18n.t('settings.configDirSync.confirm'))
					.setCta()
					.onClick(() => {
						this.close()
						this.onResult(true)
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText(i18n.t('settings.configDirSync.cancel'))
					.onClick(() => {
						this.close()
						this.onResult(false)
					}),
			)
	}

	onClose() {
		this.contentEl.empty()
	}
}

class ConfigDirSyncWarningModal extends Modal {
	constructor(
		app: App,
		private configDir: string,
		private onResult: (confirmed: boolean) => void,
	) {
		super(app)
	}

	onOpen() {
		const { contentEl } = this
		const warningKeys = [
			i18n.t('settings.configDirSync.warnSyncs', { configDir: this.configDir }),
			i18n.t('settings.configDirSync.warnExcludes', {
				configDir: this.configDir,
			}),
			i18n.t('settings.configDirSync.warnConflict', {
				configDir: this.configDir,
			}),
			i18n.t('settings.configDirSync.warnRisk', { configDir: this.configDir }),
		]
		contentEl.createEl('h2', {
			text: i18n.t('settings.configDirSync.warnTitle'),
		})
		for (const text of warningKeys) {
			contentEl.createEl('p', { text: text })
		}
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(i18n.t('settings.configDirSync.confirm'))
					.setCta()
					.onClick(() => {
						this.close()
						this.onResult(true)
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText(i18n.t('settings.configDirSync.cancel'))
					.onClick(() => {
						this.close()
						this.onResult(false)
					}),
			)
	}

	onClose() {
		this.contentEl.empty()
	}
}
