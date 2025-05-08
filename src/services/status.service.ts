import { Notice } from 'obsidian'
import NutstorePlugin from '../index'

export class StatusService {
	public syncStatusBar: HTMLElement

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
}
