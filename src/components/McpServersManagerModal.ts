import { Modal, Notice, Setting, setIcon } from 'obsidian'
import {
	isMcpServerEnabled,
	MCP_CONFIG_VIRTUAL_PATH,
	type McpServerConfigs,
} from '~/ai/mcp/types'
import i18n from '~/i18n'
import type { McpServerRuntimeInfo } from '~/services/mcp.service'
import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'
import McpServerEditorModal, {
	type McpServerDraft,
} from './McpServerEditorModal'

export default class McpServersManagerModal extends Modal {
	constructor(
		private plugin: NutstorePlugin,
		private onChanged: () => Promise<void> | void,
	) {
		super(plugin.app)
	}

	onOpen() {
		void this.plugin.mcpService.reload().then(() => this.render())
		this.render()
	}

	private get servers(): McpServerConfigs {
		return this.plugin.mcpService.getServers()
	}

	private render() {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h2', {
			text: i18n.t('settings.ai.mcp.manager.title'),
		})

		const parseError = this.plugin.mcpService.getParseError()
		if (parseError) {
			contentEl.createDiv({
				cls: ':uno: setting-item-description mod-warning',
				text: i18n.t('settings.ai.mcp.manager.parseError', {
					path: MCP_CONFIG_VIRTUAL_PATH,
					reason: parseError,
				}),
			})
		}

		new Setting(contentEl)
			.setName(i18n.t('settings.ai.mcp.name'))
			.setDesc(
				i18n.t('settings.ai.mcp.manager.configFileHint', {
					path: MCP_CONFIG_VIRTUAL_PATH,
				}),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.ai.mcp.manager.add'))
					.setCta()
					.onClick(() => {
						new McpServerEditorModal(
							this.plugin,
							{
								name: '',
								config: { type: 'http', url: '', enabled: true },
							},
							async (draft) => {
								if (!(await this.saveDraft(draft))) {
									return false
								}
								return true
							},
							true,
						).open()
					}),
			)

		const entries = Object.entries(this.servers)
		if (entries.length === 0) {
			contentEl.createDiv({
				cls: ':uno: setting-item-description',
				text: i18n.t('settings.ai.mcp.manager.empty'),
			})
			return
		}

		const runtimes = new Map(
			this.plugin.mcpService
				.getServerRuntimes()
				.map((runtime) => [runtime.name, runtime]),
		)
		for (const [name, config] of entries) {
			this.renderServer(contentEl, name, config, runtimes.get(name))
		}
	}

	private renderServer(
		contentEl: HTMLElement,
		name: string,
		config: McpServerConfigs[string],
		runtime: McpServerRuntimeInfo | undefined,
	) {
		const enabled = isMcpServerEnabled(config)
		const descParts: string[] = [config.url]
		if (!enabled) {
			descParts.push(i18n.t('settings.ai.mcp.manager.statusDisabled'))
		} else if (runtime?.status === 'connected') {
			descParts.push(
				i18n.t('settings.ai.mcp.manager.statusConnected', {
					count: runtime.tools.length,
				}),
			)
		} else if (runtime?.error) {
			descParts.push(
				i18n.t('settings.ai.mcp.manager.statusError', {
					reason: runtime.error,
				}),
			)
		}

		new Setting(contentEl)
			.setName(name)
			.setDesc(descParts.join(' · '))
			.addToggle((toggle) =>
				toggle
					.setValue(enabled)
					.setTooltip(i18n.t('settings.ai.mcp.editor.enabled'))
					.onChange(async (value) => {
						await this.saveServers({
							...this.servers,
							[name]: { ...config, enabled: value },
						})
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.ai.mcp.manager.test'))
					.onClick(async () => {
						button.setDisabled(true)
						try {
							const tools = await this.plugin.mcpService.testConnection(config)
							new Notice(
								i18n.t('settings.ai.mcp.manager.testSuccess', {
									count: tools.length,
								}),
							)
						} catch (error) {
							logger.error(error)
							new Notice(
								i18n.t('settings.ai.mcp.manager.testFailed', {
									reason:
										error instanceof Error ? error.message : String(error),
								}),
								10000,
							)
						} finally {
							button.setDisabled(false)
						}
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.ai.modals.provider.edit'))
					.onClick(() => {
						new McpServerEditorModal(
							this.plugin,
							{ name, config: cloneHttpConfig(config) },
							async (draft) => {
								if (!(await this.saveDraft(draft, name))) {
									return false
								}
								return true
							},
							false,
						).open()
					}),
			)
			.addButton((button) => {
				let confirmDelete = false

				const resetButton = () => {
					confirmDelete = false
					button.buttonEl.empty()
					setIcon(button.buttonEl, 'trash')
					removeClassTokens(button.buttonEl, ':uno: mod-warning')
				}

				button.setIcon('trash').onClick(async () => {
					if (!confirmDelete) {
						confirmDelete = true
						button.buttonEl.empty()
						button.buttonEl.createSpan({
							text: i18n.t('settings.ai.modals.confirmDeleteLabel'),
						})
						addClassTokens(button.buttonEl, ':uno: mod-warning')
						return
					}
					const servers = { ...this.servers }
					delete servers[name]
					await this.saveServers(servers)
				})
				button.buttonEl.addEventListener('blur', resetButton)
			})
	}

	private async saveDraft(draft: McpServerDraft, currentName?: string) {
		if (draft.name !== currentName && this.servers[draft.name]) {
			new Notice(i18n.t('settings.ai.mcp.errors.duplicateName'))
			return false
		}
		const servers = { ...this.servers }
		if (currentName && currentName !== draft.name) {
			delete servers[currentName]
		}
		servers[draft.name] = draft.config
		return this.saveServers(servers)
	}

	private async saveServers(servers: McpServerConfigs) {
		try {
			await this.plugin.mcpService.saveServers(servers)
			await this.onChanged()
			this.render()
			return true
		} catch (error) {
			logger.error(error)
			new Notice(
				error instanceof Error
					? error.message
					: i18n.t('settings.ai.errors.saveFailed'),
				10000,
			)
			return false
		}
	}

	onClose() {
		this.contentEl.empty()
	}
}

function cloneHttpConfig(config: McpServerConfigs[string]) {
	return {
		type: 'http' as const,
		url: config.url,
		headers: config.headers ? { ...config.headers } : undefined,
		enabled: config.enabled,
	}
}
