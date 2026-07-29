import { cloneDeep } from 'lodash-es'
import { Modal, Notice, Setting } from 'obsidian'
import { type HttpMcpServerConfig, isValidMcpServerName } from '~/ai/mcp/types'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

export interface McpServerDraft {
	name: string
	config: HttpMcpServerConfig
}

interface HeaderRow {
	key: string
	value: string
}

export default class McpServerEditorModal extends Modal {
	private draft: McpServerDraft
	private headerRows: HeaderRow[]

	constructor(
		plugin: NutstorePlugin,
		draft: McpServerDraft,
		private onSave: (draft: McpServerDraft) => Promise<boolean> | boolean,
		private isNew: boolean,
	) {
		super(plugin.app)
		this.draft = cloneDeep(draft)
		this.headerRows = Object.entries(this.draft.config.headers ?? {}).map(
			([key, value]) => ({ key, value }),
		)
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h2', {
			text: this.isNew
				? i18n.t('settings.ai.mcp.editor.createTitle')
				: i18n.t('settings.ai.mcp.editor.editTitle'),
		})

		new Setting(contentEl)
			.setName(i18n.t('settings.ai.mcp.editor.serverName'))
			.setDesc(i18n.t('settings.ai.mcp.editor.serverNameDesc'))
			.then((s) => s.settingEl.addClass(':uno: setting-required'))
			.addText((text) => {
				text.setValue(this.draft.name).onChange((value) => {
					this.draft.name = value.trim()
				})
				if (this.isNew) {
					text.inputEl.focus()
				}
			})

		new Setting(contentEl)
			.setName(i18n.t('settings.ai.mcp.editor.url'))
			.setDesc(i18n.t('settings.ai.mcp.editor.urlDesc'))
			.then((s) => s.settingEl.addClass(':uno: setting-required'))
			.addText((text) =>
				text
					.setPlaceholder('https://example.com/mcp')
					.setValue(this.draft.config.url)
					.onChange((value) => {
						this.draft.config.url = value.trim()
					}),
			)

		const headersSetting = new Setting(contentEl)
			.setName(i18n.t('settings.ai.mcp.editor.headers'))
			.setDesc(i18n.t('settings.ai.mcp.editor.headersDesc'))
		const headersContainer = contentEl.createDiv()
		const renderHeaders = () => {
			headersContainer.empty()
			for (const row of this.headerRows) {
				new Setting(headersContainer)
					.addText((text) =>
						text
							.setPlaceholder(
								i18n.t('settings.ai.mcp.editor.headerKeyPlaceholder'),
							)
							.setValue(row.key)
							.onChange((value) => {
								row.key = value
							}),
					)
					.addText((text) =>
						text
							.setPlaceholder(
								i18n.t('settings.ai.mcp.editor.headerValuePlaceholder'),
							)
							.setValue(row.value)
							.onChange((value) => {
								row.value = value
							}),
					)
					.addButton((button) =>
						button
							.setIcon('trash')
							.setTooltip(i18n.t('settings.ai.mcp.editor.removeHeader'))
							.onClick(() => {
								this.headerRows = this.headerRows.filter(
									(candidate) => candidate !== row,
								)
								renderHeaders()
							}),
					)
			}
		}
		renderHeaders()
		headersSetting.addButton((button) =>
			button
				.setButtonText(i18n.t('settings.ai.mcp.editor.addHeader'))
				.onClick(() => {
					this.headerRows.push({ key: '', value: '' })
					renderHeaders()
				}),
		)

		new Setting(contentEl)
			.setName(i18n.t('settings.ai.mcp.editor.enabled'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.draft.config.enabled !== false)
					.onChange((value) => {
						this.draft.config.enabled = value
					}),
			)

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText(i18n.t('settings.filters.save'))
				.setCta()
				.onClick(async () => {
					if (!this.validate()) {
						return
					}
					const headers: Record<string, string> = {}
					for (const row of this.headerRows) {
						const key = row.key.trim()
						if (key) {
							headers[key] = row.value
						}
					}
					const toSave = cloneDeep(this.draft)
					toSave.config.headers =
						Object.keys(headers).length > 0 ? headers : undefined
					try {
						const saved = await this.onSave(toSave)
						if (saved) {
							this.close()
						}
					} catch (error) {
						logger.error(error)
						new Notice(
							error instanceof Error
								? error.message
								: i18n.t('settings.ai.errors.saveFailed'),
							10000,
						)
					}
				}),
		)
	}

	private validate() {
		if (!this.draft.name) {
			new Notice(i18n.t('settings.ai.mcp.errors.emptyName'))
			return false
		}
		if (!isValidMcpServerName(this.draft.name)) {
			new Notice(i18n.t('settings.ai.mcp.errors.invalidName'))
			return false
		}
		if (!this.draft.config.url) {
			new Notice(i18n.t('settings.ai.mcp.errors.emptyUrl'))
			return false
		}
		try {
			new URL(this.draft.config.url)
		} catch {
			new Notice(i18n.t('settings.ai.mcp.errors.invalidUrl'))
			return false
		}
		return true
	}

	onClose() {
		this.contentEl.empty()
	}
}
