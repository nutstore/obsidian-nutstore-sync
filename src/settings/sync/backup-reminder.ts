import { Setting } from 'obsidian'
import i18n from '~/i18n'
import BaseSettings from '../settings.base'

export default class SyncBackupReminderSettings extends BaseSettings {
	readonly name = () => i18n.t('settings.backupWarning.name')
	readonly searchable = false
	readonly showGroupHeading = false

	getSearchTerms(): string[] {
		return []
	}

	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.backupWarning.name'))
			.setDesc(i18n.t('settings.backupWarning.desc'))
	}
}
