import { clamp } from 'lodash-es'
import { SyncStartMode } from '~/sync'
import type NutstorePlugin from '..'
import { BaseService } from './service.interface'
import type SyncExecutorService from './sync-executor.service'

export default class ScheduledSyncService extends BaseService {
	private autoSyncTimer: number | null = null
	private startupSyncTimer: number | null = null
	private startupSyncCompleted = false

	constructor(
		private plugin: NutstorePlugin,
		private syncExecutor: SyncExecutorService,
	) {
		super()
	}

	override async onload() {
		await this.start()
	}

	async start() {
		this.stopTimer()
		this.clearStartupTimer()
		this.startupSyncCompleted = false
		await this.scheduleStartupOrInterval()
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

	private clearStartupTimer() {
		if (this.startupSyncTimer !== null) {
			window.clearTimeout(this.startupSyncTimer)
			this.startupSyncTimer = null
		}
	}

	private async scheduleStartupOrInterval() {
		const settings = this.plugin.settings

		if (!this.startupSyncCompleted && settings.startupSyncDelaySeconds > 0) {
			this.startupSyncTimer = window.setTimeout(async () => {
				this.startupSyncTimer = null
				this.startupSyncCompleted = true
				try {
					await this.syncExecutor.executeSync({
						mode: SyncStartMode.AUTO_SYNC,
					})
				} finally {
					this.startTimer(this.plugin.settings.autoSyncIntervalSeconds)
				}
			}, settings.startupSyncDelaySeconds * 1000)
			return
		}

		this.startupSyncCompleted = true
		this.startTimer(settings.autoSyncIntervalSeconds)
	}

	private stopTimer() {
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer)
			this.autoSyncTimer = null
		}
	}

	async updateInterval() {
		this.stopTimer()
		if (!this.startupSyncCompleted) {
			this.clearStartupTimer()
			await this.scheduleStartupOrInterval()
			return
		}

		this.startTimer(this.plugin.settings.autoSyncIntervalSeconds)
	}

	override onunload() {
		this.stopTimer()
		this.clearStartupTimer()
	}
}
