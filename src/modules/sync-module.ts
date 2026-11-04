import { Notice } from 'obsidian'
import type NutstorePlugin from '~/index'
import i18n from '~/i18n'
import { emitCancelSync, emitStopGc } from '~/events'
import { SyncStartMode } from '~/sync'
import SyncExecutorService from '~/services/sync-executor.service'
import { WebDAVService } from '~/services/webdav.service'
import GcService from '~/services/gc.service'
import ScheduledSyncService from '~/services/scheduled-sync.service'
import RealtimeSyncService from '~/services/realtime-sync.service'
import EventsService from '~/services/events.service'
import { ProgressService } from '~/services/progress.service'
import { StatusService } from '~/services/status.service'
import { SyncRibbonManager } from '~/components/SyncRibbonManager'
import SyncConfirmModal from '~/components/SyncConfirmModal'
import type { SyncSelection } from '~/settings'
import { ModuleLifecycle, type ModuleScope } from './lifecycle'

/** Owns synchronization, its triggers and its presentation for one plugin. */
export class SyncModule {
	readonly executor: SyncExecutorService
	readonly webdav: WebDAVService
	readonly gc: GcService
	readonly scheduled: ScheduledSyncService
	readonly realtime: RealtimeSyncService
	readonly events: EventsService
	readonly progress: ProgressService
	readonly status: StatusService
	readonly ribbon: SyncRibbonManager
	readonly lifecycle = new ModuleLifecycle(
		(scope) => this.start(scope),
		() => this.stop(),
	)

	constructor(private readonly plugin: NutstorePlugin) {
		this.executor = new SyncExecutorService(plugin)
		this.webdav = new WebDAVService(plugin)
		this.gc = new GcService(plugin)
		this.scheduled = new ScheduledSyncService(plugin, this.executor)
		this.realtime = new RealtimeSyncService(plugin, this.executor)
		this.events = new EventsService(plugin)
		this.progress = new ProgressService(plugin)
		this.status = new StatusService(plugin)
		this.ribbon = new SyncRibbonManager(plugin)
	}

	private start(scope: ModuleScope) {
		for (const service of [
			this.events,
			this.progress,
			this.status,
			this.ribbon,
			this.realtime,
		]) {
			service.onload()
			scope.register(() => service.onunload())
		}
		this.plugin.addCommand({
			id: 'start-sync',
			name: i18n.t('sync.startButton'),
			icon: 'refresh-cw',
			checkCallback: (checking) => {
				if (scope.signal.aborted || this.executor.isRunning()) return false
				if (!checking) this.requestSync()
				return true
			},
		})
		this.plugin.addCommand({
			id: 'stop-sync',
			name: i18n.t('sync.stopButton'),
			icon: 'x-circle',
			checkCallback: (checking) => {
				if (scope.signal.aborted || !this.executor.isRunning()) return false
				if (!checking) emitCancelSync()
				return true
			},
		})
		this.plugin.addCommand({
			id: 'show-sync-progress',
			name: i18n.t('sync.showProgressButton'),
			icon: 'activity',
			checkCallback: (checking) => {
				if (scope.signal.aborted) return false
				if (!checking) this.progress.showProgressModal()
				return true
			},
		})
		scope.register(() => {
			for (const id of ['start-sync', 'stop-sync', 'show-sync-progress'])
				this.plugin.removeCommand(id)
		})
		void this.scheduled.start()
		scope.register(() => this.scheduled.onunload())
	}

	private async stop() {
		emitCancelSync()
		emitStopGc()
		await this.plugin.settingTab?.accountSettings.hide()
		await this.executor.stop()
		await this.gc.waitUntilIdle()
		this.plugin.toggleSyncUI(false)
	}

	/** Commands and ribbon share confirmation, account checks and execution. */
	requestSync() {
		if (!this.lifecycle.active) return
		if (this.executor.isRunning()) {
			this.progress.showProgressModal()
			return
		}
		const scope = this.lifecycle.scope
		if (!this.plugin.isAccountConfigured()) {
			new Notice(i18n.t('sync.error.accountNotConfigured'))
			this.plugin.app.setting?.open()
			this.plugin.app.setting?.openTabById(this.plugin.manifest.id)
			return
		}
		const run = (selection: Partial<SyncSelection> = {}) => {
			if (!scope.signal.aborted)
				void this.executor.executeSync({
					mode: SyncStartMode.MANUAL_SYNC,
					...selection,
				})
		}
		if (this.plugin.settings.confirmBeforeSync) {
			scope
				.ownModal(
					new SyncConfirmModal(
						this.plugin.app,
						this.plugin.settings,
						this.plugin.localSettings,
						run,
					),
				)
				.open()
		} else run()
	}
}
