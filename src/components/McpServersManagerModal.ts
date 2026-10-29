import { ButtonComponent, Modal, Notice, Setting, setIcon } from 'obsidian'
import {
	isMcpServerEnabled,
	MCP_CONFIG_VIRTUAL_PATH,
	type McpServerConfigs,
} from '~/ai/mcp/types'
import { MCP_DISCOVERY_SERVERS } from '~/ai/mcp/discovery'
import i18n from '~/i18n'
import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'
import McpServerEditorModal, {
	type McpServerDraft,
} from './McpServerEditorModal'

export default class McpServersManagerModal extends Modal {
	private tab: 'installed' | 'discover' = 'installed'
	private stopRuntimeUpdates?: () => void
	private readonly updateDescriptions = new Set<() => void>()
	private readonly moduleScope
	private readonly mcp
	constructor(
		private plugin: NutstorePlugin,
		private onChanged: () => Promise<void> | void,
	) {
		super(plugin.app)
		this.moduleScope = plugin.ai.lifecycle.scope
		this.mcp = plugin.ai.mcp
		this.moduleScope.ownModal(this)
		addClassTokens(this.modalEl, ':uno: w-[760px] max-w-[95vw]')
	}

	onOpen() {
		this.stopRuntimeUpdates = this.mcp.onRuntimeChanged(() => {
			for (const update of this.updateDescriptions) update()
		})
		void this.moduleScope.background(
			async () => {
				await this.mcp.reload()
				this.render()
			},
			(error) => logger.error(error),
		)
		this.render()
	}

	private get servers(): McpServerConfigs {
		return this.mcp.getServers()
	}

	private render() {
		if (this.moduleScope.signal.aborted) return
		const { contentEl } = this
		this.updateDescriptions.clear()
		contentEl.empty()
		contentEl.createEl('h2', {
			text: i18n.t('settings.ai.mcp.manager.title'),
		})

		const tabs = contentEl.createDiv({ cls: ':uno: flex gap-2 mb-5' })
		tabs.setAttribute('role', 'group')
		for (const tab of ['installed', 'discover'] as const) {
			const button = new ButtonComponent(tabs)
				.setButtonText(i18n.t(`settings.ai.mcp.discovery.${tab}`))
				.onClick(() => {
					this.tab = tab
					this.render()
				})
			button.buttonEl.setAttribute('aria-pressed', String(this.tab === tab))
			if (this.tab === tab) button.setCta()
		}
		if (this.tab === 'discover') {
			this.renderDiscovery(contentEl)
			return
		}

		const parseError = this.mcp.getParseError()
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
							{ isNew: true },
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

		for (const [name, config] of entries) {
			this.renderServer(contentEl, name, config)
		}
	}

	private renderDiscovery(contentEl: HTMLElement) {
		contentEl.createEl('p', {
			cls: ':uno: text-[var(--text-muted)] text-sm mb-5',
			text: i18n.t('settings.ai.mcp.discovery.intro'),
		})
		const grid = contentEl.createDiv({
			cls: ':uno: grid grid-cols-1 sm:grid-cols-2 gap-3',
		})
		for (const server of MCP_DISCOVERY_SERVERS) {
			const card = grid.createDiv({
				cls: ':uno: flex flex-col gap-2 p-4 min-w-0 rounded-xl border border-solid border-[var(--background-modifier-border)] bg-[var(--background-secondary)]',
			})
			const heading = card.createDiv({ cls: ':uno: flex items-center gap-2' })
			const icon = heading.createDiv({
				cls: ':uno: flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--background-primary)] text-[var(--text-accent)] shrink-0 [&_svg]:w-5 [&_svg]:h-5',
			})
			setIcon(icon, server.icon)
			const identity = heading.createDiv({
				cls: ':uno: flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0',
			})
			identity.createEl('h3', {
				text: server.name,
				cls: ':uno: m-0 text-base break-words min-w-0',
			})
			const badge = identity.createSpan({
				cls: ':uno: inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
				text: i18n.t(`settings.ai.mcp.discovery.${server.auth}`),
			})
			const badgeColors = {
				noKey:
					':uno: text-[var(--text-success)] bg-[rgba(var(--color-green-rgb),0.12)]',
				optionalKey:
					':uno: text-[var(--text-accent)] bg-[var(--background-modifier-active-hover)]',
				requiresKey:
					':uno: text-[var(--text-warning)] bg-[rgba(var(--color-orange-rgb),0.12)]',
			} as const
			addClassTokens(badge, badgeColors[server.auth])
			card.createEl('p', {
				cls: ':uno: m-0 text-sm text-[var(--text-muted)] grow',
				text: i18n.t(`settings.ai.mcp.discovery.${server.id}`),
			})
			const link = heading.createEl('a', {
				href: server.website,
				cls: ':uno: ml-auto flex items-center justify-center shrink-0 w-7 h-7 text-[var(--text-muted)] [&_svg]:w-4 [&_svg]:h-4',
			})
			link.setAttribute(
				'aria-label',
				i18n.t('settings.ai.mcp.discovery.website'),
			)
			link.setAttribute('title', i18n.t('settings.ai.mcp.discovery.website'))
			setIcon(link, 'external-link')
			link.setAttribute('target', '_blank')
			link.setAttribute('rel', 'noopener noreferrer')
			const result = card.createDiv({
				cls: ':uno: text-xs text-[var(--text-muted)] break-words empty:hidden',
			})
			result.setAttribute('role', 'status')
			const actions = card.createDiv({
				cls: ':uno: flex flex-wrap items-center justify-end gap-2',
			})
			const installed = Object.entries(this.servers).find(
				([, config]) =>
					config.url.replace(/\/$/, '') === server.url.replace(/\/$/, ''),
			)
			let confirmRemove = false
			const add = new ButtonComponent(actions)
				.setButtonText(
					i18n.t(
						installed
							? 'settings.ai.mcp.discovery.remove'
							: 'settings.ai.mcp.manager.add',
					),
				)
				.onClick(async () => {
					if (installed) {
						if (!confirmRemove) {
							confirmRemove = true
							add.setButtonText(i18n.t('settings.ai.modals.confirmDeleteLabel'))
							addClassTokens(add.buttonEl, ':uno: mod-warning')
							return
						}
						add.setDisabled(true)
						if (
							!(await this.saveServers((current) => {
								const servers = { ...current }
								delete servers[installed[0]]
								return servers
							}))
						)
							add.setDisabled(false)
						return
					}
					let name: string = server.id
					let suffix = 2
					while (this.servers[name]) name = `${server.id}-${suffix++}`
					const draft: McpServerDraft = {
						name,
						config: { type: 'http', url: server.url, enabled: true },
					}
					if (server.auth === 'requiresKey') {
						draft.config.headers = {
							[server.credentialHeader.name]: server.credentialHeader.value,
						}
						new McpServerEditorModal(
							this.plugin,
							draft,
							async (configured) => (await this.saveDraft(configured)) === true,
							{
								isNew: true,
								initialFocus: {
									header: server.credentialHeader.name,
									field: 'value',
								},
							},
						).open()
						return
					}
					add.setDisabled(true)
					try {
						const saved = await this.saveDraft(draft)
						if (!saved) add.setDisabled(false)
					} catch (error) {
						add.setDisabled(false)
						logger.error(error)
					}
				})
			if (!installed) add.setCta()
			addClassTokens(add.buttonEl, ':uno: text-xs')
			add.buttonEl.addEventListener('blur', () => {
				if (!installed) return
				confirmRemove = false
				add.setButtonText(i18n.t('settings.ai.mcp.discovery.remove'))
				removeClassTokens(add.buttonEl, ':uno: mod-warning')
			})
			const test = new ButtonComponent(actions)
				.setButtonText(i18n.t('settings.ai.mcp.manager.test'))
				.onClick(async () => {
					test.setDisabled(true)
					result.setText(i18n.t('settings.ai.mcp.discovery.testing'))
					try {
						const tools = await this.mcp.testConnection(
							installed?.[1] ?? { type: 'http', url: server.url },
						)
						if (this.moduleScope.signal.aborted) return
						result.setText(
							i18n.t('settings.ai.mcp.manager.testSuccess', {
								count: tools.length,
							}),
						)
					} catch (error) {
						if (this.moduleScope.signal.aborted) return
						result.setText(
							i18n.t('settings.ai.mcp.manager.testFailed', {
								reason: error instanceof Error ? error.message : String(error),
							}),
						)
					} finally {
						test.setDisabled(false)
					}
				})
			addClassTokens(test.buttonEl, ':uno: text-xs')
			actions.prepend(test.buttonEl)
		}
	}

	private renderServer(
		contentEl: HTMLElement,
		name: string,
		config: McpServerConfigs[string],
	) {
		const enabled = isMcpServerEnabled(config)
		const description = () => {
			const runtime = this.mcp
				.getServerRuntimes()
				.find((server) => server.name === name)
			const descParts: string[] = [config.url]
			if (!enabled) {
				descParts.push(i18n.t('settings.ai.mcp.manager.statusDisabled'))
			} else if (runtime?.status === 'connecting') {
				descParts.push(i18n.t('settings.ai.mcp.manager.statusConnecting'))
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

			return descParts.join(' · ')
		}

		new Setting(contentEl)
			.setName(name)
			.setDesc(description())
			.then((setting) =>
				this.updateDescriptions.add(() => {
					setting.setDesc(description())
				}),
			)
			.addToggle((toggle) =>
				toggle
					.setValue(enabled)
					.setTooltip(i18n.t('settings.ai.mcp.editor.enabled'))
					.onChange(async (value) => {
						await this.saveServers((current) => {
							const currentConfig = current[name]
							if (!currentConfig) return current
							return {
								...current,
								[name]: { ...currentConfig, enabled: value },
							}
						})
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.ai.mcp.manager.test'))
					.onClick(async () => {
						button.setDisabled(true)
						try {
							const tools = await this.mcp.testConnection(config)
							new Notice(
								i18n.t('settings.ai.mcp.manager.testSuccess', {
									count: tools.length,
								}),
							)
						} catch (error) {
							if (this.moduleScope.signal.aborted) return
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
							{ isNew: false },
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
					await this.saveServers((current) => {
						const servers = { ...current }
						delete servers[name]
						return servers
					})
				})
				button.buttonEl.addEventListener('blur', resetButton)
			})
	}

	private async saveDraft(draft: McpServerDraft, currentName?: string) {
		return this.saveServers((current) => {
			if (draft.name !== currentName && current[draft.name]) {
				throw new Error(i18n.t('settings.ai.mcp.errors.duplicateName'))
			}
			const servers = { ...current }
			if (currentName && currentName !== draft.name) delete servers[currentName]
			servers[draft.name] = draft.config
			return servers
		})
	}

	private async saveServers(
		servers: (current: McpServerConfigs) => McpServerConfigs,
	) {
		try {
			await this.mcp.saveServers(servers)
			this.moduleScope.check()
			await this.onChanged()
			this.render()
			return true
		} catch (error) {
			if (this.moduleScope.signal.aborted) return
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
		this.stopRuntimeUpdates?.()
		this.updateDescriptions.clear()
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
