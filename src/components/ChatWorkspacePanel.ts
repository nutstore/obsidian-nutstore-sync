import { Menu, Modal, Notice, setIcon } from 'obsidian'
import type NutstorePlugin from '~/index'
import { appIdSchema, type SavedApp } from '~/ai/apps/domain'
import { appError } from '~/ai/apps/error'
import i18n from '~/i18n'

/** The composer exposes the chat target; Apps render in the main workspace view. */
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
		menu.addSeparator()
		menu.addItem((item) =>
			item
				.setTitle(i18n.t('apps.newApp'))
				.setIcon('plus')
				.onClick(() => this.create()),
		)
		const id = this.activeId
		if (id) {
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
		const { appId: id, busy } = this.plugin.ai.chat.workspaceState
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

	private create() {
		const modal = this.plugin.ai.lifecycle.scope.ownModal(
			new Modal(this.plugin.app),
		)
		modal.setTitle(i18n.t('apps.newApp'))
		modal.modalEl.addClass('ns-workspace-create-modal')
		modal.contentEl.createEl('p', {
			cls: 'ns-workspace-create-description',
			text: i18n.t('apps.workspaceDescription'),
		})
		const label = modal.contentEl.createEl('label', {
			cls: 'ns-workspace-create-label',
			text: i18n.t('apps.appTitle'),
		})
		const input = label.createEl('input', {
			attr: {
				'aria-label': i18n.t('apps.appTitle'),
				placeholder: i18n.t('apps.appTitle'),
				maxlength: '100',
			},
		})
		const idLabel = modal.contentEl.createEl('label', {
			cls: 'ns-workspace-create-label',
			text: i18n.t('apps.appId'),
		})
		const idInput = idLabel.createEl('input', {
			attr: {
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- App identities are lowercase package names.
				placeholder: 'org.example.counter',
				maxlength: '100',
				'aria-label': i18n.t('apps.appId'),
			},
		})
		const footer = modal.contentEl.createDiv({
			cls: 'ns-workspace-create-footer',
		})
		const button = footer.createEl('button', {
			text: i18n.t('apps.create'),
			cls: 'mod-cta',
		})
		button.disabled = true
		const update = () => {
			button.disabled =
				!input.value.trim() ||
				!appIdSchema.safeParse(idInput.value.trim()).success
		}
		input.addEventListener('input', update)
		idInput.addEventListener('input', update)
		const create = async () => {
			if (!input.value.trim() || button.disabled) return
			button.disabled = true
			input.disabled = true
			try {
				const saved = await this.plugin.ai.workspaces.create(
					idInput.value.trim(),
					input.value.trim(),
				)
				await this.plugin.ai.chat.selectWorkspace(saved.id)
				modal.close()
			} catch (error) {
				new Notice(appError(error))
				button.disabled = false
				input.disabled = false
			}
		}
		button.addEventListener('click', () => {
			void create()
		})
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault()
				void create()
			}
		})
		modal.open()
		input.focus()
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
