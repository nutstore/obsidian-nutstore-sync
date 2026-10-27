import { addIcon, removeIcon } from 'obsidian'
import type NutstorePlugin from '~/index'
import type { ModuleScope } from '~/modules/lifecycle'
import type { AppStore } from '~/ai/apps/store'
import { appIconId, appIconContent, validateAppIcon } from '~/ai/apps/icon'
import logger from '~/utils/logger'
import { createScopedRibbonIcon } from '~/utils/scoped-ribbon-icon'

/** App icons and pins belong to the AI module lifetime; pinned App identity survives reloads. */
export default class AppRibbonManager {
	private readonly entries = new Map<
		string,
		{ signature: string; dispose?: () => void }
	>()
	private pending = false
	private refreshing?: Promise<void>
	constructor(
		private readonly plugin: NutstorePlugin,
		private readonly scope: ModuleScope,
		private readonly apps: AppStore,
	) {
		scope.register(apps.subscribe(() => this.schedule()))
		scope.register(() => {
			for (const id of [...this.entries.keys()]) this.remove(id)
		})
		this.schedule()
	}
	private schedule() {
		this.pending = true
		if (this.refreshing) return
		this.refreshing = this.scope
			.background(
				async () => {
					while (this.pending && !this.scope.signal.aborted) {
						this.pending = false
						await this.refresh()
					}
				},
				(error) => logger.error(error),
			)
			.finally(() => {
				this.refreshing = undefined
				if (this.pending && !this.scope.signal.aborted) this.schedule()
			})
	}
	async refresh() {
		const items = await this.apps.list()
		this.scope.check()
		const live = new Set<string>()
		for (const item of items) {
			if (!item.app) continue
			const saved = item.app
			try {
				const svg = validateAppIcon(
					saved.manifest.iconSvg,
					this.plugin.app.workspace.containerEl.ownerDocument,
				)
				live.add(item.id)
				const signature = JSON.stringify([
					svg,
					saved.manifest.title,
					saved.state.pinned,
				])
				if (this.entries.get(item.id)?.signature === signature) continue
				this.remove(item.id)
				const icon = appIconId(item.id)
				addIcon(icon, appIconContent(svg))
				const { open, checkCallback } = this.createOpenCallbacks(item.id)
				const ribbon = saved.state.pinned
					? createScopedRibbonIcon(
							this.plugin,
							icon,
							saved.manifest.title,
							open,
							item.id,
						)
					: undefined
				if (ribbon) ribbon.element.dataset.nutstoreAppId = item.id
				this.plugin.addCommand({
					id: `open-app-${item.id}`,
					name: saved.manifest.title,
					icon,
					checkCallback,
				})
				this.entries.set(item.id, { signature, dispose: ribbon?.dispose })
			} catch (error) {
				logger.error(error)
			}
		}
		for (const id of [...this.entries.keys()])
			if (!live.has(id)) this.remove(id)
	}
	private createOpenCallbacks(appId: string) {
		const open = () => {
			void this.scope.background(
				() => this.plugin.ai.openApp(appId),
				(error) => logger.error(error),
			)
		}
		return {
			open,
			checkCallback: (checking: boolean) => {
				if (this.scope.signal.aborted) return false
				if (!checking) open()
				return true
			},
		}
	}
	private remove(id: string) {
		const entry = this.entries.get(id)
		if (!entry) return
		entry.dispose?.()
		this.plugin.removeCommand(`open-app-${id}`)
		removeIcon(appIconId(id))
		this.entries.delete(id)
	}
}
