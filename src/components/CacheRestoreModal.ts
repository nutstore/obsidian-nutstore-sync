import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import { StatModel } from '~/model/stat.model'
import CacheService from '~/services/cache.service'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

export default class CacheRestoreModal extends Modal {
	private fileList: HTMLElement
	private files: StatModel[] = []
	private cacheService: CacheService

	constructor(
		app: App,
		private plugin: NutstorePlugin,
		private remoteCacheDir: string,
		private onSuccess?: () => void,
	) {
		super(app)
		this.cacheService = new CacheService(plugin, remoteCacheDir)
	}

	async onOpen() {
		const { contentEl } = this

		new Setting(contentEl)
			.setName(i18n.t('settings.cache.restoreModal.title'))
			.setDesc(i18n.t('settings.cache.restoreModal.description'))

		this.fileList = contentEl.createDiv({
			cls: 'max-h-50vh overflow-y-auto pb-2 flex flex-col',
		})

		await this.loadFileList()

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.cache.restoreModal.refresh'))
					.onClick(async () => {
						await this.loadFileList()
					})
			})
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.cache.restoreModal.close'))
					.onClick(() => {
						this.close()
					})
			})
	}

	private async loadFileList() {
		try {
			this.files = await this.cacheService.loadCacheFileList()

			if (this.files.length === 0) {
				this.renderEmptyList()
				return
			}

			// Render file list
			this.fileList.empty()
			this.files.forEach(({ basename }) => {
				const fileItem = this.fileList.createDiv({
					cls: 'flex justify-between items-center py-2',
				})

				fileItem.createSpan({
					text: basename,
					cls: 'flex-1 overflow-hidden text-ellipsis whitespace-nowrap mr-10px',
				})

				const actionContainer = fileItem.createDiv({
					cls: 'flex gap-2',
				})

				const restoreBtn = actionContainer.createEl('button', {
					text: i18n.t('settings.cache.restoreModal.restore'),
					cls: 'mod-cta',
				})
				restoreBtn.addEventListener('click', async () => {
					try {
						await this.cacheService.restoreCache(basename)
						this.onSuccess?.()
						this.close()
					} catch (error) {
						// Error is already handled in the service
					}
				})

				let confirmedDelete = false
				const deleteBtn = actionContainer.createEl('button', {
					text: i18n.t('settings.cache.restoreModal.delete'),
					cls: 'transition',
				})
				deleteBtn.addEventListener('click', async () => {
					if (confirmedDelete) {
						try {
							await this.cacheService.deleteCache(basename)
							await this.loadFileList()
						} catch (error) {
							// Error is already handled in the service
						}
					} else {
						confirmedDelete = true
						deleteBtn.setText(
							i18n.t('settings.cache.restoreModal.deleteConfirm'),
						)
						deleteBtn.classList.add('mod-warning')
					}
				})
				deleteBtn.addEventListener('blur', () => {
					confirmedDelete = false
					deleteBtn.setText(i18n.t('settings.cache.restoreModal.delete'))
					deleteBtn.classList.remove('mod-warning')
				})
			})
		} catch (error) {
			logger.error('Error loading cache file list:', error)
			this.fileList.empty()
			this.fileList.createEl('p', {
				text: i18n.t('settings.cache.restoreModal.loadError', {
					message: error.message,
				}),
				cls: 'p-12px text-center text-[var(--text-error)]',
			})
		}
	}

	private renderEmptyList() {
		this.fileList.empty()
		this.fileList.createEl('p', {
			text: i18n.t('settings.cache.restoreModal.noFiles'),
			cls: 'p-12px text-center',
		})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
