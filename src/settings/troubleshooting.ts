import { apiVersion, Notice, Platform, setIcon, Setting } from 'obsidian'
import { CHATBOX_AI_ICON_ID } from '~/assets/icons/obsidian-nutstore-ai-icon'
import CacheClearModal from '~/components/CacheClearModal'
import { IN_DEV } from '~/consts'
import i18n from '~/i18n'
import { blobStore } from '~/storage/blob'
import { formatLocalTimestampForFilename } from '~/utils/local-date'
import logger from '~/utils/logger'
import logsStringify from '~/utils/logs-stringify'
import BaseSettings from './settings.base'

export default class TroubleshootingSettings extends BaseSettings {
	getSearchTerms(): string[] {
		return [
			i18n.t('settings.troubleshooting.pluginInfo'),
			i18n.t('settings.cache.clearName'),
			i18n.t('settings.cache.clearDesc'),
			i18n.t('settings.log.name'),
			i18n.t('settings.log.desc'),
			i18n.t('settings.log.clearName'),
			i18n.t('settings.log.clearDesc'),
			i18n.t('settings.cache.generateBlobGarbageName'),
			i18n.t('settings.cache.generateBlobGarbageDesc'),
		]
	}

	private readonly blobGarbageCount = 5000
	private readonly blobGarbageSizeBytes = 64 * 1024

	async display() {
		this.containerEl.empty()
		this.displayPluginInfo()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.troubleshooting.title'))
			.setHeading()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.cache.clearName'))
			.setDesc(i18n.t('settings.cache.clearDesc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.cache.clear'))
					.onClick(async () => {
						new CacheClearModal(this.plugin, async (options) => {
							try {
								const cleared =
									await CacheClearModal.clearSelectedCaches(options)
								if (cleared.length > 0) {
									new Notice(i18n.t('settings.cache.cleared'))
								} else {
									new Notice(
										i18n.t('settings.cache.clearModal.nothingSelected'),
									)
								}
							} catch (error) {
								logger.error('Error clearing cache:', error)
								const message =
									error instanceof Error ? error.message : String(error)
								new Notice(`Error clearing cache: ${message}`)
							}
						}).open()
					})
			})

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

		if (IN_DEV) {
			new Setting(this.containerEl)
				.setName(i18n.t('settings.cache.generateBlobGarbageName'))
				.setDesc(
					i18n.t('settings.cache.generateBlobGarbageDesc', {
						count: this.blobGarbageCount,
						sizeKiB: this.blobGarbageSizeBytes / 1024,
					}),
				)
				.addButton((button) => {
					button
						.setButtonText(i18n.t('settings.cache.generateBlobGarbage'))
						.onClick(async () => {
							button.setDisabled(true)
							try {
								new Notice(i18n.t('settings.cache.generateBlobGarbageRunning'))
								const created = await this.generateBlobGarbage()
								new Notice(
									i18n.t('settings.cache.generateBlobGarbageDone', {
										count: created,
									}),
								)
							} catch (error) {
								logger.error('Error generating blob garbage:', error)
								new Notice(`Error: ${(error as Error).message}`)
							} finally {
								button.setDisabled(false)
							}
						})
				})
		}
	}

	private displayPluginInfo() {
		const card = this.containerEl.createDiv({ cls: 'nutstore-plugin-info' })
		card.setAttribute('role', 'group')
		card.setAttribute(
			'aria-label',
			i18n.t('settings.troubleshooting.pluginInfo'),
		)
		const header = card.createDiv({ cls: 'nutstore-plugin-info__header' })
		const icon = header.createDiv({ cls: 'nutstore-plugin-info__icon' })
		icon.setAttribute('aria-hidden', 'true')
		setIcon(icon, CHATBOX_AI_ICON_ID)
		const identity = header.createDiv({ cls: 'nutstore-plugin-info__identity' })
		identity.createDiv({
			cls: 'nutstore-plugin-info__name',
			text: this.plugin.manifest.name,
		})
		identity.createDiv({
			cls: 'nutstore-plugin-info__version',
			text: `v${this.plugin.manifest.version}`,
		})

		const platform = Platform.isIosApp
			? 'iOS'
			: Platform.isAndroidApp
				? 'Android'
				: Platform.isMacOS
					? 'macOS'
					: Platform.isWin
						? 'Windows'
						: Platform.isLinux
							? 'Linux'
							: i18n.t('settings.troubleshooting.unknownPlatform')
		const details = card.createEl('dl', {
			cls: 'nutstore-plugin-info__details',
		})
		const fields = [
			['Obsidian', apiVersion],
			[i18n.t('settings.troubleshooting.platform'), platform],
			[
				i18n.t('settings.troubleshooting.language'),
				i18n.resolvedLanguage === 'zh' ? '简体中文' : 'English',
			],
		]
		for (const [label, value] of fields) {
			const field = details.createDiv({ cls: 'nutstore-plugin-info__field' })
			field.createEl('dt', { text: label })
			field.createEl('dd', { text: value })
		}
	}

	hide() {}

	private get logs() {
		return this.plugin.loggerService.logs
			.map(logsStringify)
			.filter((log) => log !== null && log !== undefined)
			.join('\n\n')
	}

	private async saveLogsToNote() {
		try {
			const now = new Date()
			const timestamp = formatLocalTimestampForFilename(now)
			const fileName = `nutstore-logs-${timestamp}.md`
			const dirPath = 'nutstore-sync/logs'
			const filePath = `${dirPath}/${fileName}`
			const content = `# Nutstore Plugin Logs\n\nGenerated at: ${now.toLocaleString()}\n\nPlugin version: ${this.plugin.manifest.version}\n\n---\n\n${this.logs}`

			const folderExists = await this.app.vault.adapter.exists(dirPath)
			if (!folderExists) {
				await this.app.vault.adapter.mkdir(dirPath)
			}

			const file = await this.app.vault.create(filePath, content)
			new Notice(i18n.t('settings.log.savedToNote', { fileName: filePath }))
			await this.app.workspace.getLeaf().openFile(file)
		} catch (error) {
			new Notice(i18n.t('settings.log.saveError'))
			logger.error('Failed to save logs to note:', error)
		}
	}

	private async generateBlobGarbage() {
		function createRandomBytes(size: number) {
			const bytes = new Uint8Array(size)
			if (window.crypto?.getRandomValues) {
				window.crypto.getRandomValues(bytes)
				return bytes
			}
			for (let i = 0; i < bytes.length; i++) {
				bytes[i] = Math.floor(Math.random() * 256)
			}
			return bytes
		}

		let created = 0
		for (let i = 0; i < this.blobGarbageCount; i++) {
			const payload = createRandomBytes(this.blobGarbageSizeBytes)
			await blobStore.store(payload.buffer)
			created++
		}
		return created
	}
}
