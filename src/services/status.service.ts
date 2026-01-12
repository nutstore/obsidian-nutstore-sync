import { Notice } from 'obsidian'
import i18n from '../i18n'
import NutstorePlugin from '../index'
import { formatRelativeTime } from '../utils/format-relative-time'

export class StatusService {
	public syncStatusBar: HTMLElement
	private lastSyncTime: number | null = null
	private updateInterval: number | null = null
	private baseStatusText: string = ''

	constructor(private plugin: NutstorePlugin) {
		this.syncStatusBar = plugin.addStatusBarItem()
	}

	/**
	 * Updates the sync status display in the status bar
	 */
	public updateSyncStatus(status: {
		text: string
		isError?: boolean
		showNotice?: boolean
	}): void {
		this.syncStatusBar.setText(status.text)

		if (status.showNotice) {
			new Notice(status.text)
		}
	}

	/**
	 * Set the last sync completion time and start updating the status bar
	 */
	public setLastSyncTime(timestamp: number, failedCount: number = 0): void {
		this.lastSyncTime = timestamp
		this.baseStatusText =
			failedCount > 0
				? i18n.t('sync.completeWithFailed', { failedCount })
				: i18n.t('sync.complete')

		// Update immediately
		this.updateStatusBarWithTime()

		// Clear any existing interval
		this.stopTimeUpdates()

		// Update every minute
		this.updateInterval = window.setInterval(() => {
			this.updateStatusBarWithTime()
		}, 60000)
	}

	/**
	 * Updates the status bar with relative time
	 */
	private updateStatusBarWithTime(): void {
		if (this.lastSyncTime === null) {
			return
		}

		const now = Date.now()
		const diffSeconds = Math.floor((now - this.lastSyncTime) / 1000)

		// Don't show relative time if less than 60 seconds (just now)
		if (diffSeconds < 60) {
			this.syncStatusBar.setText(this.baseStatusText)
		} else {
			const relativeTime = formatRelativeTime(this.lastSyncTime)
			const statusText = `${this.baseStatusText} (${relativeTime})`
			this.syncStatusBar.setText(statusText)
		}
	}

	/**
	 * Stop updating the status bar time
	 */
	public stopTimeUpdates(): void {
		if (this.updateInterval !== null) {
			window.clearInterval(this.updateInterval)
			this.updateInterval = null
		}
	}

	public unload(): void {
		this.stopTimeUpdates()
	}
}
