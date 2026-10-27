import type { EventRef } from 'obsidian'
import { MarkdownView, Notice, TFile } from 'obsidian'
import { sanitizeDefaultSelections } from '~/ai/catalog/config'
import { createVaultPathContextItem } from '~/ai/chat/context/user-context'
import i18n from '~/i18n'
import { countMergeConflictBlocks } from '~/utils/merge-conflict-markers'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'
import { BaseService } from './service.interface'

export default class AIConflictResolverService extends BaseService {
	private readonly actions = new Map<MarkdownView, HTMLElement>()
	private refreshVersion = 0
	private unloaded = false
	private refs: Array<() => void> = []

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override onload() {
		this.unloaded = false
		this.registerWorkspaceEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => {
				void this.refresh()
			}),
		)
		this.registerWorkspaceEvent(
			this.plugin.app.workspace.on('file-open', () => {
				void this.refresh()
			}),
		)
		this.registerVaultEvent(
			this.plugin.app.vault.on('modify', (file) => {
				const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)
				if (file instanceof TFile && view?.file?.path === file.path) {
					void this.refresh()
				}
			}),
		)
		void this.refresh()
	}

	private registerWorkspaceEvent(ref: EventRef) {
		this.refs.push(() => this.plugin.app.workspace.offref(ref))
	}
	private registerVaultEvent(ref: EventRef) {
		this.refs.push(() => this.plugin.app.vault.offref(ref))
	}

	async refresh() {
		const version = ++this.refreshVersion
		if (this.unloaded || !this.plugin.ai.lifecycle.active) return
		const scope = this.plugin.ai.lifecycle.scope
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)
		if (!view) return

		const action = this.getOrCreateAction(view)
		const file = view.file
		if (!file || !this.hasConfiguredModel()) {
			action.hide()
			return
		}

		try {
			const content = await this.plugin.app.vault.cachedRead(file)
			if (
				scope.signal.aborted ||
				this.unloaded ||
				version !== this.refreshVersion ||
				view.file?.path !== file.path
			) {
				return
			}
			const count = countMergeConflictBlocks(content)
			if (count === 0) {
				action.hide()
				return
			}

			const title = i18n.t('chatbox.conflictResolution.action', { count })
			action.setAttribute('aria-label', title)
			action.setAttribute('data-tooltip-position', 'bottom')
			action.setAttribute('aria-disabled', 'false')
			action.setAttribute('title', title)
			action.show()
		} catch (error) {
			if (scope.signal.aborted) return
			action.hide()
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
		action.hide()
		this.actions.set(view, action)
		return action
	}

	override onunload() {
		this.refs.splice(0).forEach((dispose) => dispose())
		this.unloaded = true
		this.refreshVersion++
		for (const action of this.actions.values()) {
			action.remove()
		}
		this.actions.clear()
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
		if (!this.plugin.ai.lifecycle.active) return
		const scope = this.plugin.ai.lifecycle.scope
		const action = this.getOrCreateAction(view)
		const file = view.file
		if (!file || action.getAttribute('aria-disabled') === 'true') return

		action.setAttribute('aria-disabled', 'true')
		try {
			if (!this.hasConfiguredModel()) {
				action.hide()
				new Notice(i18n.t('chatbox.conflictResolution.modelUnavailable'))
				return
			}

			const content = await this.plugin.app.vault.cachedRead(file)
			if (scope.signal.aborted) return
			if (countMergeConflictBlocks(content) === 0) {
				action.hide()
				new Notice(i18n.t('chatbox.conflictResolution.alreadyResolved'))
				return
			}

			await this.plugin.ai.chat.createDraftSession(
				i18n.t('chatbox.conflictResolution.prompt'),
				[createVaultPathContextItem(file.path, 'file')],
			)
			await this.plugin.ai.openChatbox()
		} catch (error) {
			if (scope.signal.aborted) return
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
