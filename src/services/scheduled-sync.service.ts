import type { ModuleScope } from '~/modules/lifecycle'
import { clamp } from 'es-toolkit/compat'
import { SyncStartMode } from '~/sync'
import type NutstorePlugin from '..'
import { BaseService } from './service.interface'
import type SyncExecutorService from './sync-executor.service'

export default class ScheduledSyncService extends BaseService {
	private autoSyncTimer: number | null = null
	private startupSyncTimer: number | null = null
	private startupSyncCompleted = false
	private scope?: ModuleScope
	private scheduleKey = ''

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
		this.scope = this.plugin.sync.lifecycle.scope
		this.scheduleKey = this.getScheduleKey()
		this.stopTimer()
		this.clearStartupTimer()
		this.startupSyncCompleted = false
		const scope = this.scope
		this.plugin.app.workspace.onLayoutReady(() => {
			if (scope.signal.aborted || this.scope !== scope) return
			this.scheduleKey = this.getScheduleKey()
			void this.scheduleStartupOrInterval()
		})
	}

	private startTimer(intervalSeconds: number) {
		if (!this.scope || this.scope.signal.aborted) return
		const scope = this.scope
		this.stopTimer()

		const intervalMs = intervalSeconds * 1000
		const clampedIntervalMs = clamp(intervalMs, 0, 2 ** 31 - 1)

		if (clampedIntervalMs > 0) {
			this.autoSyncTimer = window.setInterval(() => {
				if (scope.signal.aborted) return
				void this.syncExecutor.executeSync({
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
		if (!this.scope || this.scope.signal.aborted) return
		if (!this.plugin.app.workspace.layoutReady) return
		const scope = this.scope
		const settings = this.plugin.settings

		if (!this.startupSyncCompleted && settings.startupSyncDelaySeconds > 0) {
			this.startupSyncTimer = window.setTimeout(() => {
				if (scope.signal.aborted) return
				this.startupSyncTimer = null
				this.startupSyncCompleted = true
				void (async () => {
					try {
						await this.syncExecutor.executeSync({
							mode: SyncStartMode.AUTO_SYNC,
						})
					} finally {
						if (!scope.signal.aborted)
							this.startTimer(this.plugin.settings.autoSyncIntervalSeconds)
					}
				})()
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

	private getScheduleKey() {
		return `${this.plugin.settings.startupSyncDelaySeconds}:${this.plugin.settings.autoSyncIntervalSeconds}`
	}

	async updateInterval() {
		if (!this.scope || this.scope.signal.aborted) return
		if (!this.plugin.app.workspace.layoutReady) return
		const key = this.getScheduleKey()
		if (key === this.scheduleKey) return
		this.scheduleKey = key
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
		this.scope = undefined
	}
}
