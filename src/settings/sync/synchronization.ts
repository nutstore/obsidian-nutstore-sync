import { DropdownComponent, Notice, Setting } from 'obsidian'
import SelectRemoteBaseDirModal from '~/components/SelectRemoteBaseDirModal'
import SyncPolicyModal from '~/components/SyncPolicyModal'
import i18n from '~/i18n'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { SyncMode, SyncPolicy } from '..'
import BaseSettings from '../settings.base'

/** Sync destination and rules that apply to every synchronization run. */
export default class SynchronizationSettings extends BaseSettings {
	readonly name = () => i18n.t('settings.sections.sync')
	readonly showGroupHeading = true

	getSearchTerms(): string[] {
		return [
			i18n.t('settings.remoteDir.name'),
			i18n.t('settings.remoteDir.desc'),
			i18n.t('settings.syncPolicy.name'),
			i18n.t('settings.syncPolicy.desc'),
			i18n.t('settings.conflictStrategy.name'),
			i18n.t('settings.conflictStrategy.desc'),
			i18n.t('settings.confirmBeforeSync.name'),
			i18n.t('settings.confirmBeforeSync.desc'),
			i18n.t('settings.confirmBeforeDeleteInAutoSync.name'),
			i18n.t('settings.confirmBeforeDeleteInAutoSync.desc'),
			i18n.t('settings.syncMode.name'),
			i18n.t('settings.syncMode.desc'),
		]
	}

	async display() {
		this.containerEl.empty()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.remoteDir.name'))
			.setDesc(i18n.t('settings.remoteDir.desc'))
			.addText((text) => {
				text
					.setPlaceholder(i18n.t('settings.remoteDir.placeholder'))
					.setValue(this.plugin.remoteBaseDir)
					.onChange(async (value) => {
						this.plugin.settings.remoteDir = value
						await this.plugin.settingsService.saveSettings()
					})
				text.inputEl.addEventListener('blur', () => {
					this.plugin.settings.remoteDir = this.plugin.remoteBaseDir
					void this.display()
				})
			})
			.addButton((button) => {
				button.setIcon('folder').onClick(() => {
					if (!this.plugin.isAccountConfigured()) {
						new Notice(i18n.t('sync.error.accountNotConfigured'))
						return
					}
					new SelectRemoteBaseDirModal(this.app, this.plugin, async (path) => {
						this.plugin.settings.remoteDir = path
						await this.plugin.settingsService.saveSettings()
						void this.display()
					}).open()
				})
			})

		let syncPolicyDropdown!: DropdownComponent
		new Setting(this.containerEl)
			.setName(i18n.t('settings.syncPolicy.name'))
			.setDesc(i18n.t('settings.syncPolicy.desc'))
			.addDropdown((dropdown) => {
				syncPolicyDropdown = dropdown
					.addOption(SyncPolicy.TwoWay, i18n.t('settings.syncPolicy.twoWay'))
					.addOption(
						SyncPolicy.SendOnly,
						i18n.t('settings.syncPolicy.sendOnly'),
					)
					.addOption(
						SyncPolicy.SendOnlyOverrideChanges,
						i18n.t('settings.syncPolicy.sendOnlyOverrideChanges'),
					)
					.addOption(
						SyncPolicy.ReceiveOnly,
						i18n.t('settings.syncPolicy.receiveOnly'),
					)
					.addOption(
						SyncPolicy.ReceiveOnlyRevertLocalChanges,
						i18n.t('settings.syncPolicy.receiveOnlyRevertLocalChanges'),
					)
					.setValue(this.plugin.localSettings.syncPolicy)
					.onChange(async (value) => {
						const previous = this.plugin.localSettings.syncPolicy
						const confirmed = await new SyncPolicyModal(
							this.app,
							value as SyncPolicy,
						).openAndWait()
						if (confirmed) {
							this.plugin.localSettings.syncPolicy = value as SyncPolicy
							await this.plugin.settingsService.saveLocalSettings()
						} else {
							syncPolicyDropdown.setValue(previous)
						}
					})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.conflictStrategy.name'))
			.setDesc(i18n.t('settings.conflictStrategy.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						ConflictStrategy.NoConflictMerge,
						i18n.t('settings.conflictStrategy.noConflictMerge'),
					)
					.addOption(
						ConflictStrategy.Diff3,
						i18n.t('settings.conflictStrategy.diff3'),
					)
					.addOption(
						ConflictStrategy.LocalPriority,
						i18n.t('settings.conflictStrategy.localPriority'),
					)
					.addOption(
						ConflictStrategy.ServerPriority,
						i18n.t('settings.conflictStrategy.serverPriority'),
					)
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value) => {
						this.plugin.settings.conflictStrategy = value as ConflictStrategy
						await this.plugin.settingsService.saveSettings()
					}),
			)

		this.addConfirmationToggle('confirmBeforeSync')
		this.addConfirmationToggle('confirmBeforeDeleteInAutoSync')

		new Setting(this.containerEl)
			.setName(i18n.t('settings.syncMode.name'))
			.setDesc(i18n.t('settings.syncMode.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption(SyncMode.STRICT, i18n.t('settings.syncMode.strict'))
					.addOption(SyncMode.LOOSE, i18n.t('settings.syncMode.loose'))
					.setValue(this.plugin.settings.syncMode)
					.onChange(async (value) => {
						this.plugin.settings.syncMode = value as SyncMode
						await this.plugin.settingsService.saveSettings()
					}),
			)
	}

	private addConfirmationToggle(
		key: 'confirmBeforeSync' | 'confirmBeforeDeleteInAutoSync',
	) {
		new Setting(this.containerEl)
			.setName(i18n.t(`settings.${key}.name`))
			.setDesc(i18n.t(`settings.${key}.desc`))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
					this.plugin.settings[key] = value
					await this.plugin.settingsService.saveSettings()
				}),
			)
	}
}
