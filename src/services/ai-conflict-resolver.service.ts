import { MarkdownView, Notice, TFile } from 'obsidian'
import { sanitizeDefaultSelections } from '~/ai/catalog/config'
import { createVaultPathContextItem } from '~/ai/chat/context/user-context'
import i18n from '~/i18n'
import { countMergeConflictBlocks } from '~/utils/merge-conflict-markers'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'
import { BaseService } from './service.interface'

export default class AIConflictResolverService extends BaseService {
	private readonly actions = new WeakMap<MarkdownView, HTMLElement>()
	private refreshVersion = 0

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override onload() {
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => {
				void this.refresh()
			}),
		)
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('file-open', () => {
				void this.refresh()
			}),
		)
		this.plugin.registerEvent(
			this.plugin.app.vault.on('modify', (file) => {
				const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)
				if (file instanceof TFile && view?.file?.path === file.path) {
					void this.refresh()
				}
			}),
		)
		void this.refresh()
	}

	async refresh() {
		const version = ++this.refreshVersion
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)
		if (!view) return

		const action = this.getOrCreateAction(view)
		const file = view.file
		if (!file || !this.hasConfiguredModel()) {
			action.hidden = true
			return
		}

		try {
			const content = await this.plugin.app.vault.cachedRead(file)
			if (version !== this.refreshVersion || view.file?.path !== file.path) {
				return
			}
			const count = countMergeConflictBlocks(content)
			action.hidden = count === 0
			const title = i18n.t('chatbox.conflictResolution.action', { count })
			action.setAttribute('aria-label', title)
			action.setAttribute('data-tooltip-position', 'bottom')
			action.setAttribute('aria-disabled', 'false')
			action.setAttribute('title', title)
		} catch (error) {
			action.hidden = true
			logger.error(`Failed to inspect merge conflicts: ${file.path}`, error)
		}
	}

	private getOrCreateAction(view: MarkdownView) {
		const existing = this.actions.get(view)
		if (existing) return existing

		const action = view.addAction(
			'git-merge',
			i18n.t('chatbox.conflictResolution.action', { count: 1 }),
			() => {
				void this.prepareResolution(view)
			},
		)
		action.hidden = true
		this.actions.set(view, action)
		return action
	}

	private hasConfiguredModel() {
		return Boolean(
			sanitizeDefaultSelections(
				this.plugin.settings.ai.providers,
				this.plugin.settings.ai.defaultModel,
			),
		)
	}

	private async prepareResolution(view: MarkdownView) {
		const action = this.getOrCreateAction(view)
		const file = view.file
		if (!file || action.getAttribute('aria-disabled') === 'true') return

		action.setAttribute('aria-disabled', 'true')
		try {
			if (!this.hasConfiguredModel()) {
				action.hidden = true
				new Notice(i18n.t('chatbox.conflictResolution.modelUnavailable'))
				return
			}

			const content = await this.plugin.app.vault.cachedRead(file)
			if (countMergeConflictBlocks(content) === 0) {
				action.hidden = true
				new Notice(i18n.t('chatbox.conflictResolution.alreadyResolved'))
				return
			}

			await this.plugin.chatService.createDraftSession(
				i18n.t('chatbox.conflictResolution.prompt'),
				[createVaultPathContextItem(file.path, 'file')],
			)
			await this.plugin.commandService.openChatbox()
		} catch (error) {
			logger.error(
				`Failed to prepare AI conflict resolution: ${file.path}`,
				error,
			)
			new Notice(i18n.t('chatbox.conflictResolution.failed'))
		} finally {
			action.setAttribute('aria-disabled', 'false')
			void this.refresh()
		}
	}
}
