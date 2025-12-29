import { clamp } from 'lodash-es'
import { useSettings } from '~/settings'
import { SyncStartMode } from '~/sync'
import type NutstorePlugin from '..'
import type SyncExecutorService from './sync-executor.service'

export default class ScheduledSyncService {
	private autoSyncTimer: number | null = null
	private startupSyncTimer: number | null = null

	constructor(
		private plugin: NutstorePlugin,
		private syncExecutor: SyncExecutorService,
	) {}

	async start() {
		const settings = await useSettings()

		if (settings.startupSyncDelaySeconds > 0) {
			this.startupSyncTimer = window.setTimeout(async () => {
				try {
					await this.syncExecutor.executeSync({
						mode: SyncStartMode.AUTO_SYNC,
					})
				} finally {
					this.startTimer(settings.autoSyncIntervalSeconds)
				}
			}, settings.startupSyncDelaySeconds * 1000)
		} else {
			this.startTimer(settings.autoSyncIntervalSeconds)
		}
	}

	private startTimer(intervalSeconds: number) {
		this.stopTimer()

		const intervalMs = intervalSeconds * 1000
		const clampedIntervalMs = clamp(intervalMs, 0, 2 ** 31 - 1)

		if (clampedIntervalMs > 0) {
			this.autoSyncTimer = window.setInterval(async () => {
				await this.syncExecutor.executeSync({
					mode: SyncStartMode.AUTO_SYNC,
				})
			}, clampedIntervalMs)
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
		if (this.startupSyncTimer !== null) {
			window.clearTimeout(this.startupSyncTimer)
			this.startupSyncTimer = null
		}
	}
}
