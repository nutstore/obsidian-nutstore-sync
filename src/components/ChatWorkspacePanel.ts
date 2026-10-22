import { Menu, Modal, Notice, Platform, setIcon } from 'obsidian'
import type NutstorePlugin from '~/index'
import type { SavedApp } from '~/ai/apps/store'
import { appError } from '~/ai/apps/error'
import { formatAppCreationPrompt } from '~/ai/apps/create-app-prompt'
import i18n from '~/i18n'
import AppCreationModal from './AppCreationModal'

/**
 * The composer exposes the chat target. Apps are authored through conversation
 * and render in the main workspace view; their IDs stay an internal detail.
 */
export class ChatWorkspacePanel {
	private readonly host: HTMLElement
	private readonly picker: HTMLButtonElement
	private readonly title: HTMLElement
	private readonly workspaceIcon: HTMLElement
	private readonly status: HTMLElement
	private readonly unsubscribers: Array<() => void>
	private items: Array<{ id: string; app?: SavedApp }> = []
	private saved?: SavedApp
	private activeId?: string
	private observedSessionId?: string
	private renderedIcon?: { appId?: string; svg?: string }
	private epoch = 0
	private closed = false
	constructor(
		container: HTMLElement,
		private readonly plugin: NutstorePlugin,
	) {
		this.host = container.createDiv({ cls: 'ns-chat-workspace' })
		this.picker = this.host.createEl('button', {
			cls: 'ns-workspace-picker',
			attr: { type: 'button', 'aria-haspopup': 'menu' },
		})
		this.workspaceIcon = this.picker.createSpan({ cls: 'ns-workspace-icon' })
		this.title = this.picker.createSpan({ cls: 'ns-workspace-title' })
		setIcon(
			this.picker.createSpan({ cls: 'ns-workspace-chevron' }),
			'chevron-down',
		)
		this.status = this.host.createDiv({
			cls: 'ns-app-status',
			attr: { role: 'status' },
		})
		this.picker.addEventListener('click', () => this.showPicker())
		this.unsubscribers = [
			plugin.ai.chat.subscribe(() => this.update()),
			plugin.ai.apps.subscribe(() => {
				void this.refresh()
			}),
		]
		this.update()
		void this.refresh()
	}
	private selectWorkspace(id?: string) {
		void this.plugin.ai.chat.selectWorkspace(id).catch((error) => {
			new Notice(appError(error))
			void this.refresh()
		})
	}
	private showPicker() {
		if (this.plugin.ai.chat.workspaceState.busy) return
		const menu = new Menu()
		menu.addItem((item) =>
			item
				.setTitle(i18n.t('apps.noWorkspace'))
				.setIcon('sparkles')
				.setChecked(!this.activeId)
				.onClick(() => this.selectWorkspace()),
		)
		menu.addItem((item) =>
			item
				.setTitle(i18n.t('apps.createApp'))
				.setIcon('plus')
				.onClick(() => this.openCreateApp()),
		)
		for (const app of this.items) {
			menu.addItem((item) =>
				item
					.setTitle(
						app.app?.manifest.title ??
							`${app.id} · ${i18n.t('apps.missingApp')}`,
					)
					.setIcon('blocks')
					.setChecked(app.id === this.activeId)
					.onClick(() => this.selectWorkspace(app.id)),
			)
		}
		const id = this.activeId
		if (id) {
			menu.addSeparator()
			menu.addItem((item) =>
				item
					.setTitle(i18n.t('apps.openApp'))
					.setIcon('external-link')
					.setDisabled(!this.saved)
					.onClick(() => {
						void this.plugin.ai
							.openApp(id)
							.catch((error) => new Notice(appError(error)))
					}),
			)
			menu.addSeparator()
			menu.addItem((item) =>
				item
					.setTitle(i18n.t('apps.deleteApp'))
					.setIcon('trash-2')
					.setDisabled(!this.saved)
					.onClick(() => this.confirmDelete()),
			)
		}
		const rect = this.picker.getBoundingClientRect()
		menu.showAtPosition({ x: rect.left, y: rect.bottom })
	}
	private openCreateApp() {
		const modal = this.plugin.ai.lifecycle.scope.ownModal(
			new AppCreationModal(this.plugin.app, async ({ name, description }) => {
				await this.plugin.ai.chat.createDraftSession(
					formatAppCreationPrompt({ name, description }),
				)
				await this.plugin.ai.chat.selectWorkspace(undefined)
			}),
		)
		modal.open()
	}
	private syncWorkspaceIcon() {
		const appId = this.activeId
		const svg = this.saved?.manifest.iconSvg
		if (
			this.renderedIcon &&
			this.renderedIcon.appId === appId &&
			this.renderedIcon.svg === svg
		)
			return
		this.workspaceIcon.empty()
		if (!this.activeId) {
			setIcon(this.workspaceIcon, 'sparkles')
			this.renderedIcon = { appId, svg }
			return
		}
		setIcon(
			this.workspaceIcon,
			this.plugin.ai.appIcon(this.activeId, this.saved?.manifest.iconSvg),
		)
		if (!this.workspaceIcon.childElementCount) {
			setIcon(this.workspaceIcon, 'blocks')
		}
		this.renderedIcon = { appId, svg }
	}
	private update() {
		if (this.closed) return
		const { sessionId, appId: id, busy } = this.plugin.ai.chat.workspaceState
		const enteredSession = sessionId !== this.observedSessionId
		this.observedSessionId = sessionId
		if (enteredSession && sessionId && id && Platform.isDesktopApp) {
			// Restore the session's App once per entry. Workspace changes made
			// inside that session remain explicit user actions.
			void this.plugin.ai.openApp(id).catch((error) => {
				if (!this.closed && this.observedSessionId === sessionId)
					this.status.textContent = appError(error)
			})
		}
		if (id !== this.activeId) {
			this.activeId = id
			this.saved = undefined
			this.status.textContent = ''
			void this.refresh()
		}
		this.syncWorkspaceIcon()
		this.picker.disabled = busy
		this.title.textContent = id
			? (this.saved?.manifest.title ?? i18n.t('apps.missingApp'))
			: i18n.t('apps.noWorkspace')
		this.picker.title = this.title.textContent
		this.picker.setAttribute(
			'aria-label',
			`${i18n.t('apps.workspace')}: ${this.title.textContent}`,
		)
		this.host.classList.toggle('has-workspace', !!id)
	}

	private async refresh() {
		const epoch = ++this.epoch
		try {
			const items = await this.plugin.ai.apps.list()
			if (this.closed || epoch !== this.epoch) return
			this.items = items
			const id = this.plugin.ai.chat.activeAppId
			const item = items.find((candidate) => candidate.id === id)
			this.saved = item?.app
			if (id && !item) {
				await this.plugin.ai.chat.selectWorkspace(undefined)
				return
			}
			this.update()
			// update may start a new read when the active binding changed.
			if (epoch !== this.epoch) return
			this.status.textContent =
				id && !this.saved ? i18n.t('apps.missingApp') : ''
		} catch (error) {
			if (!this.closed && epoch === this.epoch)
				this.status.textContent = appError(error)
		}
	}

	private confirmDelete() {
		const id = this.activeId
		if (!id) return
		const modal = this.plugin.ai.lifecycle.scope.ownModal(
			new Modal(this.plugin.app),
		)
		modal.setTitle(i18n.t('apps.deleteApp'))
		modal.contentEl.createEl('p', { text: i18n.t('apps.deleteAppPrompt') })
		const button = modal.contentEl.createEl('button', {
			text: i18n.t('apps.deleteApp'),
			cls: 'mod-warning',
		})
		button.addEventListener('click', () => {
			button.disabled = true
			void this.plugin.ai.apps
				.remove(id)
				.then(() => modal.close())
				.catch((error) => {
					new Notice(appError(error))
					button.disabled = false
				})
		})
		modal.open()
	}
	destroy() {
		this.closed = true
		this.epoch++
		for (const unsubscribe of this.unsubscribers) unsubscribe()
		this.host.remove()
	}
}
