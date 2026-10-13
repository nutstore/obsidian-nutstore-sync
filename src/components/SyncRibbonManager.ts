import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import { emitCancelSync } from '../events'
import i18n from '../i18n'
import type NutstorePlugin from '../index'
import { BaseService } from '../services/service.interface'

export class SyncRibbonManager extends BaseService {
	private startRibbonEl: HTMLElement | null = null
	private stopRibbonEl: HTMLElement | null = null

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override onload() {
		this.startRibbonEl = this.plugin.addRibbonIcon(
			'refresh-ccw',
			i18n.t('sync.startButton'),
			() => this.plugin.sync.requestSync(),
		)
		this.stopRibbonEl = this.plugin.addRibbonIcon(
			'square',
			i18n.t('sync.stopButton'),
			() => emitCancelSync(),
		)
		addClassTokens(this.stopRibbonEl, ':uno: hidden')
	}

	override onunload() {
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
