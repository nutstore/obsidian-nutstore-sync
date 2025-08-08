import { emitCancelSync } from '../events'
import i18n from '../i18n'
import type NutstorePlugin from '../index'
import { NutstoreSync } from '../sync'
import SyncConfirmModal from './SyncConfirmModal'

export class SyncRibbonManager {
	private startRibbonEl: HTMLElement
	private stopRibbonEl: HTMLElement

	constructor(private plugin: NutstorePlugin) {
		this.startRibbonEl = this.plugin.addRibbonIcon(
			'refresh-ccw',
			i18n.t('sync.startButton'),
			async () => {
				if (this.plugin.isSyncing) {
					return
				}
				const startSync = async () => {
					const sync = new NutstoreSync(this.plugin, {
						webdav: await this.plugin.webDAVService.createWebDAVClient(),
						vault: this.plugin.app.vault,
						token: await this.plugin.getToken(),
						remoteBaseDir: this.plugin.remoteBaseDir,
					})
					await sync.start({
						showNotice: true,
					})
				}
				new SyncConfirmModal(this.plugin.app, startSync).open()
			},
		)
		this.stopRibbonEl = this.plugin.addRibbonIcon(
			'square',
			i18n.t('sync.stopButton'),
			() => emitCancelSync(),
		)
		this.stopRibbonEl.classList.add('hidden')
	}

	public update() {
		if (this.plugin.isSyncing) {
			this.startRibbonEl.setAttr('aria-disabled', 'true')
			this.startRibbonEl.addClass('nutstore-sync-spinning')
			this.stopRibbonEl.classList.remove('hidden')
		} else {
			this.startRibbonEl.removeAttribute('aria-disabled')
			this.startRibbonEl.removeClass('nutstore-sync-spinning')
			this.stopRibbonEl.classList.add('hidden')
		}
	}
}
