import { useSettings } from '~/settings'
import type NutstorePlugin from '..'
import type SyncExecutorService from './sync-executor.service'

export default class AutoSyncService {
	private autoSyncTimer: number | null = null

	constructor(
		private plugin: NutstorePlugin,
		private syncExecutor: SyncExecutorService,
	) {}

	async start() {
		const settings = await useSettings()
		this.startTimer(settings.autoSyncIntervalSeconds)
	}

	private startTimer(intervalSeconds: number) {
		this.stopTimer()

		if (intervalSeconds > 0) {
			this.autoSyncTimer = window.setInterval(async () => {
				await this.syncExecutor.executeSync({
					showNotice: false,
				})
			}, intervalSeconds * 1000)
		}
	}

	private stopTimer() {
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer)
			this.autoSyncTimer = null
		}
	}

	async updateInterval() {
		const settings = await useSettings()
		this.startTimer(settings.autoSyncIntervalSeconds)
	}

	unload() {
		this.stopTimer()
	}
}
