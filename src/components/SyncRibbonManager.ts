import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import { emitCancelSync } from '../events'
import i18n from '../i18n'
import type NutstorePlugin from '../index'
import { BaseService } from '../services/service.interface'
import { createScopedRibbonIcon } from '~/utils/scoped-ribbon-icon'

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
		addClassTokens(this.stopRibbonEl, ':uno: hidden')
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
		if (this.plugin.isSyncing) {
			this.startRibbonEl.setAttr('aria-disabled', 'true')
			this.startRibbonEl.addClass('nutstore-sync-spinning')
			removeClassTokens(this.stopRibbonEl, ':uno: hidden')
		} else {
			this.startRibbonEl.removeAttribute('aria-disabled')
			this.startRibbonEl.removeClass('nutstore-sync-spinning')
			addClassTokens(this.stopRibbonEl, ':uno: hidden')
		}
	}
}
