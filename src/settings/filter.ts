import { App, Modal, Setting } from 'obsidian'
import FilterEditorModal from '~/components/FilterEditorModal'
import { getConfigDirPruningRule } from '~/utils/config-dir-rules'
import type { GlobFilterRule } from '~/utils/glob-match'
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
										await this.plugin.settingsService.saveSettings()
									} else {
										void this.display()
									}
								},
							).open()
						} else if (value === 'all') {
							const pruningRule = getConfigDirPruningRule(
								configDir,
								this.plugin.settings.filterRules.rules,
							)
							new ConfigDirSyncWarningModal(
								this.app,
								configDir,
								pruningRule,
								async (confirmed) => {
									if (confirmed) {
										this.plugin.settings.configDirSyncMode = 'all'
										await this.plugin.settingsService.saveSettings()
									} else {
										void this.display()
									}
								},
							).open()
						} else {
							this.plugin.settings.configDirSyncMode = value
							await this.plugin.settingsService.saveSettings()
						}
					}),
			)

		// Rules
		new Setting(this.containerEl)
			.setName(i18n.t('settings.filters.name'))
			.setDesc(i18n.t('settings.filters.desc'))
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.filters.edit')).onClick(() => {
					const rules = this.plugin.settings.filterRules.rules
					const getHighlightedRule =
						(this.plugin.settings.configDirSyncMode ?? 'none') === 'all'
							? (currentRules: GlobFilterRule[]) =>
									getConfigDirPruningRule(configDir, currentRules)
							: undefined
					new FilterEditorModal(
						this.plugin,
						rules,
						async (filters) => {
							this.plugin.settings.filterRules.rules = filters
							await this.plugin.settingsService.saveSettings()
							void this.display()
						},
						getHighlightedRule,
					).open()
				})
			})
	}
}

class ConfigDirSyncBookmarksModal extends Modal {
	private resolved = false

	constructor(
		app: App,
		private configDir: string,
		private onResult: (confirmed: boolean) => void | Promise<void>,
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
						this.resolved = true
						this.close()
						void this.onResult(true)
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText(i18n.t('settings.configDirSync.cancel'))
					.onClick(() => {
						this.resolved = true
						this.close()
						void this.onResult(false)
					}),
			)
	}

	onClose() {
		this.contentEl.empty()
		if (!this.resolved) {
			void this.onResult(false)
		}
	}
}

class ConfigDirSyncWarningModal extends Modal {
	private resolved = false

	constructor(
		app: App,
		private configDir: string,
		private pruningRule: GlobFilterRule | undefined,
		private onResult: (confirmed: boolean) => void | Promise<void>,
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
		if (this.pruningRule) {
			contentEl.createEl('p', {
				text: i18n.t('settings.configDirSync.warnPruned', {
					configDir: this.configDir,
					rule: this.pruningRule.expr,
				}),
				cls: ':uno: ns-config-dir-warning',
			})
		}
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(i18n.t('settings.configDirSync.confirm'))
					.setCta()
					.onClick(() => {
						this.resolved = true
						this.close()
						void this.onResult(true)
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText(i18n.t('settings.configDirSync.cancel'))
					.onClick(() => {
						this.resolved = true
						this.close()
						void this.onResult(false)
					}),
			)
	}

	onClose() {
		this.contentEl.empty()
		if (!this.resolved) {
			void this.onResult(false)
		}
	}
}
