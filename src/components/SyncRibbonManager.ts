import { toggleClassTokens } from '~/utils/class-tokens'
import { emitCancelSync } from '../events'
import i18n from '../i18n'
import type NutstorePlugin from '../index'
import { BaseService } from '../services/service.interface'
import { createScopedRibbonIcon } from '~/utils/scoped-ribbon-icon'

/** Obsidian re-renders ribbon actions on layout changes; only a class survives. */
const HIDDEN_CLASS = 'nutstore-ribbon-action-hidden'

export class SyncRibbonManager extends BaseService {
	private startRibbonEl: HTMLElement | null = null
	private stopRibbonEl: HTMLElement | null = null
	private readonly disposers: Array<() => void> = []

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override onload() {
		const start = createScopedRibbonIcon(
			this.plugin,
			'refresh-ccw',
			i18n.t('sync.startButton'),
			() => this.plugin.sync.requestSync(),
		)
		const stop = createScopedRibbonIcon(
			this.plugin,
			'square',
			i18n.t('sync.stopButton'),
			() => emitCancelSync(),
		)
		this.startRibbonEl = start.element
		this.stopRibbonEl = stop.element
		this.disposers.push(start.dispose, stop.dispose)
		this.update()
	}

	override onunload() {
		for (const dispose of this.disposers.splice(0).reverse()) dispose()
		this.startRibbonEl?.remove()
		this.stopRibbonEl?.remove()
		this.startRibbonEl = null
		this.stopRibbonEl = null
	}

	public update() {
		if (!this.startRibbonEl || !this.stopRibbonEl) {
			return
		}
		const syncing = this.plugin.isSyncing
		toggleClassTokens(this.startRibbonEl, HIDDEN_CLASS, syncing)
		toggleClassTokens(this.stopRibbonEl, HIDDEN_CLASS, !syncing)
	}
}
