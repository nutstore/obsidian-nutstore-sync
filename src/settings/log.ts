import { Notice, Setting } from 'obsidian'
import { isNotNil } from 'ramda'
import i18n from '~/i18n'
import logsStringify from '~/utils/logs-stringify'
import BaseSettings from './settings.base'

export default class LogSettings extends BaseSettings {
	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.log.title'))
			.setHeading()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.log.name'))
			.setDesc(i18n.t('settings.log.desc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.log.saveToNote'))
					.onClick(async () => {
						await this.saveLogsToNote()
					})
			})
		new Setting(this.containerEl)
			.setName(i18n.t('settings.log.clearName'))
			.setDesc(i18n.t('settings.log.clearDesc'))
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.log.clear')).onClick(() => {
					this.plugin.loggerService.clear()
					new Notice(i18n.t('settings.log.cleared'))
				})
			})
	}

	get logs() {
		return this.plugin.loggerService.logs
			.map(logsStringify)
			.filter(isNotNil)
			.join('\n\n')
	}

	async saveLogsToNote() {
		try {
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
			const fileName = `nutstore-logs-${timestamp}.md`
			const dirPath = 'nutstore-sync/logs'
			const filePath = `${dirPath}/${fileName}`
			const content = `# Nutstore Plugin Logs\n\nGenerated at: ${new Date().toLocaleString()}\n\n---\n\n${this.logs}`

			// 确保目录存在
			const folderExists = await this.app.vault.adapter.exists(dirPath)
			if (!folderExists) {
				await this.app.vault.createFolder(dirPath)
			}

			const file = await this.app.vault.create(filePath, content)
			new Notice(i18n.t('settings.log.savedToNote', { fileName: filePath }))

			await this.app.workspace.getLeaf().openFile(file)
		} catch (error) {
			new Notice(i18n.t('settings.log.saveError'))
			console.error('Failed to save logs to note:', error)
		}
	}
}
