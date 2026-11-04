import {
	ItemView,
	Notice,
	setIcon,
	type EventRef,
	type WorkspaceLeaf,
	type ViewStateResult,
} from 'obsidian'
import type NutstorePlugin from '~/index'
import { AppRuntime } from '~/ai/apps/runtime'
import type { LoadedApp } from '~/ai/apps/workspaces'
import { appError } from '~/ai/apps/error'
import i18n from '~/i18n'
import logger from '~/utils/logger'

export const APP_VIEW_TYPE = 'nutstore-app'

/** Apps open independently of chats, and persist only their stable App identity in the workspace. */
export default class AppView extends ItemView {
	private appId?: string
	private title?: string
	private runtime?: AppRuntime
	private readonly unsubscribers: Array<() => void> = []
	private output!: HTMLElement
	private status!: HTMLElement
	private readonly headerActions: HTMLElement[] = []
	private closed = true
	private signature = ''
	private renderEpoch = 0
	private epoch = 0
	private refreshTimer?: number
	private pinButton?: HTMLElement
	private cssChangeEvent?: EventRef
	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: NutstorePlugin,
	) {
		super(leaf)
	}
	getViewType() {
		return APP_VIEW_TYPE
	}
	getDisplayText() {
		return this.title ?? i18n.t('apps.openApp')
	}
	getIcon() {
		return this.appId ? this.plugin.ai.appIcon(this.appId) : 'app-window'
	}
	getState() {
		return { appId: this.appId }
	}
	async setState(state: unknown, result: ViewStateResult) {
		const id =
			state && typeof state === 'object'
				? (Reflect.get(state, 'appId') as unknown)
				: undefined
		this.appId = typeof id === 'string' ? id : undefined
		this.title = undefined
		this.signature = ''
		this.renderEpoch++
		this.clearRuntime()
		await super.setState(state, result)
		if (!this.closed) await this.refresh()
	}
	async onOpen() {
		if (!this.plugin.ai.lifecycle.active) {
			this.leaf.detach()
			return
		}
		this.closed = false
		this.signature = ''
		this.contentEl.empty()
		this.contentEl.addClass('ns-app-view')
		this.buildHeaderActions()
		this.status = this.contentEl.createDiv({
			cls: 'ns-app-status',
			attr: { role: 'status' },
		})
		this.output = this.contentEl.createDiv({ cls: 'ns-app-output' })
		this.cssChangeEvent = this.plugin.app.workspace.on('css-change', () => {
			this.runtime?.updateTheme()
		})
		this.unsubscribers.push(
			this.plugin.ai.apps.subscribe((changedAppId) => {
				if (!changedAppId || changedAppId === this.appId) this.scheduleRefresh()
			}),
		)
		await this.refresh()
	}

	/** Keep App chrome in Obsidian's header so the sandbox owns the full content area. */
	private buildHeaderActions() {
		const action = (
			label: string,
			icon: string,
			run: () => Promise<unknown>,
		) => {
			const button = this.addAction(icon, label, () => {
				if (!this.appId || this.closed) return
				void run().catch((error) => this.reportActionError(error))
			})
			this.headerActions.push(button)
			return button
		}
		action(i18n.t('apps.modify'), 'pencil', async () => {
			await this.plugin.ai.editApp(this.appId!)
		})
		this.pinButton = action(i18n.t('apps.pin'), 'pin', async () => {
			const current = await this.plugin.ai.apps.read(this.appId!)
			await this.plugin.ai.apps.setPinned(this.appId!, !current.state.pinned)
		})
	}
	private reportActionError(error: unknown) {
		logger.error('App action failed', this.appId, error)
		new Notice(appError(error))
	}
	/** Writes arrive per file; coalesce them into one assembled reload per burst. */
	private scheduleRefresh() {
		if (this.closed) return
		if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer)
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = undefined
			void this.refresh()
		}, 120)
	}
	private async refresh() {
		if (this.closed || !this.appId) return
		const appId = this.appId
		const epoch = ++this.epoch
		try {
			const loaded = await this.plugin.ai.workspaces.load(appId)
			if (this.closed || epoch !== this.epoch) return
			if (this.pinButton) {
				const label = i18n.t(loaded.state.pinned ? 'apps.unpin' : 'apps.pin')
				this.pinButton.setAttribute('title', label)
				this.pinButton.setAttribute('aria-label', label)
				this.pinButton.setAttribute('aria-pressed', String(loaded.state.pinned))
				setIcon(this.pinButton, loaded.state.pinned ? 'pin-off' : 'pin')
			}
			this.render(loaded)
		} catch (error) {
			if (!this.closed && epoch === this.epoch) {
				this.signature = ''
				this.renderEpoch++
				this.clearRuntime()
				this.showError(error)
			}
		}
	}
	/** File changes under the App directory hot-reload the mounted App in place. */
	private render(loaded: LoadedApp) {
		if (this.closed || !this.appId) return
		const appId = this.appId
		this.updateTitle(loaded.manifest.title)
		const signature = JSON.stringify([appId, loaded.manifest, loaded.content])
		const epoch = ++this.renderEpoch
		this.status.classList.remove('ns-app-error')
		this.status.textContent = ''
		if (signature === this.signature) return
		if (!loaded.content.html.trim() && !loaded.content.javascript.trim()) {
			this.signature = signature
			this.clearRuntime()
			const placeholder = this.output.createDiv({
				cls: 'ns-workspace-placeholder',
			})
			setIcon(
				placeholder.createDiv({ cls: 'ns-workspace-placeholder-icon' }),
				'blocks',
			)
			placeholder.createEl('h2', { text: loaded.manifest.title })
			placeholder.createEl('p', { text: i18n.t('apps.describeApp') })
			return
		}
		void (async () => {
			// Boot the candidate before swapping, so failing startup keeps the last good App visible.
			const validated = await this.plugin.ai.workspaces.validate(appId)
			if (this.closed || epoch !== this.renderEpoch) return
			this.signature = JSON.stringify([
				appId,
				validated.manifest,
				validated.content,
			])
			this.updateTitle(validated.manifest.title)
			this.clearRuntime()
			const host = this.plugin.ai.workspaces.createRuntimeHost(appId, () => {
				if (!current()) throw new Error('This App version is no longer active')
			})
			const current = () => !this.closed && this.runtime === runtime
			const runtime: AppRuntime = new AppRuntime(
				this.output,
				validated.content,
				{
					fs: host.fs,
					ai: host.ai,
					readKV: async () => {
						if (!current())
							throw new Error('This App version is no longer active')
						return host.readKV()
					},
					transact: async (changes) => {
						if (!current())
							throw new Error('This App version is no longer active')
						await host.transact(changes)
					},
					log: (event) => host.log(event),
					error: (message) => {
						if (current()) this.showError(message)
					},
				},
				validated.manifest.title,
			)
			this.runtime = runtime
			await runtime.ready
		})().catch((error) => {
			if (!this.closed && epoch === this.renderEpoch) this.showError(error)
		})
	}
	/** Obsidian creates the header before the asynchronous manifest load completes. */
	private updateTitle(title: string) {
		this.title = title
		const heading = this.containerEl.querySelector('.view-header-title')
		if (heading) heading.textContent = title
	}
	private clearRuntime() {
		this.runtime?.destroy()
		this.runtime = undefined
		this.output?.empty()
	}
	private showError(error: unknown) {
		this.status.textContent = appError(error)
		this.status.classList.add('ns-app-error')
	}
	async onClose() {
		this.closed = true
		this.epoch++
		this.renderEpoch++
		if (this.refreshTimer !== undefined) {
			window.clearTimeout(this.refreshTimer)
			this.refreshTimer = undefined
		}
		this.runtime?.destroy()
		if (this.cssChangeEvent) {
			this.plugin.app.workspace.offref(this.cssChangeEvent)
			this.cssChangeEvent = undefined
		}
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
		for (const action of this.headerActions.splice(0)) action.remove()
		this.pinButton = undefined
		this.contentEl.empty()
	}
}
