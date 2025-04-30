import { Notice } from 'obsidian'
import NutstorePlugin from '../index'

export class StatusService {
	public syncStatusBar: HTMLElement
	private statusHideTimer: number | null = null

	constructor(private plugin: NutstorePlugin) {
		this.syncStatusBar = plugin.addStatusBarItem()
		this.syncStatusBar.addClass('nutstore-sync-status', 'hidden')
	}

	/**
	 * Updates the sync status display in the status bar
	 */
	public updateSyncStatus(status: {
		text: string
		isError?: boolean
		showNotice?: boolean
		hideAfter?: number
	}): void {
		if (this.statusHideTimer) {
			clearTimeout(this.statusHideTimer)
			this.statusHideTimer = null
		}

		this.syncStatusBar.setText(status.text)
		this.syncStatusBar.removeClass('hidden')

		if (status.showNotice) {
			new Notice(status.text)
		}

		if (status.hideAfter) {
			this.statusHideTimer = window.setTimeout(() => {
				this.syncStatusBar.addClass('hidden')
				this.statusHideTimer = null
			}, status.hideAfter)
		}
	}

	/**
	 * Clean up timers when unloading
	 */
	public unload(): void {
		if (this.statusHideTimer) {
			clearTimeout(this.statusHideTimer)
			this.statusHideTimer = null
		}
	}
}
