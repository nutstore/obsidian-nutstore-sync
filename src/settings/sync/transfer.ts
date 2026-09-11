import { parse as bytesParse } from 'bytes-iec'
import { Notice, Setting, TextComponent } from 'obsidian'
import i18n from '~/i18n'
import {
	DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE,
	MAX_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES,
	MIN_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES,
	normalizeByteSizeInput,
} from '~/utils/download-chunk-size'
import BaseSettings from '../settings.base'

const MAX_FILE_SIZE = '500MB'
const MAX_FILE_BYTES = bytesParse(MAX_FILE_SIZE, { mode: 'jedec' })!

/** Limits controlling the files and chunks transferred during synchronization. */
export default class TransferSettings extends BaseSettings {
	readonly name = () => i18n.t('settings.sections.transfer')
	readonly showGroupHeading = true

	getSearchTerms(): string[] {
		return [
			i18n.t('settings.skipLargeFiles.name'),
			i18n.t('settings.skipLargeFiles.desc'),
			i18n.t('settings.mobileAppDownloadFileChunkSize.name'),
			i18n.t('settings.mobileAppDownloadFileChunkSize.desc'),
		]
	}

	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.skipLargeFiles.name'))
			.setDesc(i18n.t('settings.skipLargeFiles.desc'))
			.addText((text) => {
				text
					.setPlaceholder(i18n.t('settings.skipLargeFiles.placeholder'))
					.setValue(this.plugin.settings.skipLargeFiles.maxSize.trim())
				text.inputEl.addEventListener('blur', () => {
					void this.saveMaxFileSize(text)
				})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.mobileAppDownloadFileChunkSize.name'))
			.setDesc(i18n.t('settings.mobileAppDownloadFileChunkSize.desc'))
			.addText((text) => {
				text
					.setPlaceholder(
						i18n.t('settings.mobileAppDownloadFileChunkSize.placeholder'),
					)
					.setValue(
						this.plugin.settings.mobileAppDownloadFileChunkSize ||
							DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE,
					)
				text.inputEl.addEventListener('blur', () => {
					void this.saveMobileChunkSize(text)
				})
			})
	}

	private async saveMaxFileSize(component: TextComponent) {
		let value = normalizeByteSizeInput(component.getValue(), MAX_FILE_SIZE)
		const bytes = bytesParse(value, { mode: 'jedec' })
		if (bytes === null) {
			new Notice(i18n.t('settings.skipLargeFiles.invalidFormat'))
			component.setValue(this.plugin.settings.skipLargeFiles.maxSize)
			return
		}
		if (bytes > MAX_FILE_BYTES) {
			new Notice(i18n.t('settings.skipLargeFiles.exceedsMaxSize'))
			value = MAX_FILE_SIZE
		}
		component.setValue(value)
		if (this.plugin.settings.skipLargeFiles.maxSize !== value) {
			this.plugin.settings.skipLargeFiles.maxSize = value
			await this.plugin.settingsService.saveSettings()
		}
	}

	private async saveMobileChunkSize(component: TextComponent) {
		let value = normalizeByteSizeInput(
			component.getValue(),
			DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE,
		)
		const bytes = bytesParse(value, { mode: 'jedec' })
		if (bytes === null) {
			new Notice(
				i18n.t('settings.mobileAppDownloadFileChunkSize.invalidFormat'),
			)
			component.setValue(
				this.plugin.settings.mobileAppDownloadFileChunkSize ||
					DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE,
			)
			return
		}
		if (bytes < MIN_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES) {
			new Notice(i18n.t('settings.mobileAppDownloadFileChunkSize.belowMinSize'))
			value = '64 KiB'
		} else if (bytes > MAX_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES) {
			new Notice(
				i18n.t('settings.mobileAppDownloadFileChunkSize.exceedsMaxSize'),
			)
			value = '64 MiB'
		}
		component.setValue(value)
		if (this.plugin.settings.mobileAppDownloadFileChunkSize !== value) {
			this.plugin.settings.mobileAppDownloadFileChunkSize = value
			await this.plugin.settingsService.saveSettings()
		}
	}
}
