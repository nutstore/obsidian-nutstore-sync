import type { ModuleScope } from '~/modules/lifecycle'
import { guardVault } from '~/modules/guard-io'
import { isAbortError } from '~/utils/abort'
import { NutstoreSync, SyncStartMode } from '~/sync'
import { Notice } from 'obsidian'
import { IN_DEV } from '~/consts'
import { emitStopGc, emitSyncError } from '~/events'
import i18n from '~/i18n'
import type { SyncStartResult } from '~/sync'
import { getConfigDirPruningRule } from '~/utils/config-dir-rules'
import { getSyncPolicyLabel, getSyncTriggerLabel } from '~/sync/log'
import { type SyncPolicy } from '~/settings'
import logger from '~/utils/logger'
import waitUntil from '~/utils/wait-until'
import { BaseService } from './service.interface'
import type NutstorePlugin from '..'

export interface SyncOptions {
	mode: SyncStartMode
	/** A manual-sync override. This is deliberately not persisted. */
	syncPolicy?: SyncPolicy
}

export default class SyncExecutorService extends BaseService {
	private inFlight = false
	private pendingAutoSync = false
	private work?: Promise<boolean>

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	isRunning() {
		return this.inFlight || this.plugin.isSyncing
	}

	executeSync(options: SyncOptions): Promise<boolean> {
		if (!this.plugin.sync.lifecycle.active) return Promise.resolve(false)
		if (this.isRunning()) {
			if (options.mode === SyncStartMode.AUTO_SYNC) this.pendingAutoSync = true
			else new Notice(i18n.t('sync.blockedBySync'))
			return Promise.resolve(false)
		}
		const work = this.performSync(options, this.plugin.sync.lifecycle.scope)
		this.work = work
		return work
	}

	async stop() {
		this.pendingAutoSync = false
		await this.work
	}

	private async performSync(options: SyncOptions, scope: ModuleScope) {
		this.inFlight = true
		this.pendingAutoSync = false
		const syncPolicy =
			options.syncPolicy ?? this.plugin.localSettings.syncPolicy

		let result: SyncStartResult | undefined
		try {
			if (this.plugin.sync.gc.isRunningNow()) {
				if (IN_DEV && options.mode === SyncStartMode.MANUAL_SYNC) {
					new Notice(i18n.t('sync.stoppingGcForSync'))
				}
				emitStopGc()
				await scope.wait(this.plugin.sync.gc.waitUntilIdle())
			}

			if (!this.plugin.isAccountConfigured()) {
				new Notice(i18n.t('sync.error.accountNotConfigured'))
				return false
			}

			if (
				options.mode === SyncStartMode.MANUAL_SYNC &&
				(this.plugin.settings.configDirSyncMode ?? 'none') === 'all'
			) {
				const configDir = this.plugin.app.vault.configDir
				const pruningRule = getConfigDirPruningRule(
					configDir,
					this.plugin.settings.filterRules.rules,
				)
				if (pruningRule) {
					new Notice(
						i18n.t('settings.configDirSync.syncNotice', {
							configDir,
							rule: pruningRule.expr,
						}),
					)
				}
			}

			logger.info('Sync starting with settings:', {
				triggerMode: getSyncTriggerLabel(options.mode),
				syncPolicy: getSyncPolicyLabel(syncPolicy),
				loginMode: this.plugin.settings.loginMode,
				remoteBaseDir: this.plugin.remoteBaseDir,
				syncMode: this.plugin.settings.syncMode,
				realtimeSync: this.plugin.settings.realtimeSync,
				autoSyncIntervalSeconds: this.plugin.settings.autoSyncIntervalSeconds,
				startupSyncDelaySeconds: this.plugin.settings.startupSyncDelaySeconds,
				confirmBeforeSync: this.plugin.settings.confirmBeforeSync,
				confirmBeforeDeleteInAutoSync:
					this.plugin.settings.confirmBeforeDeleteInAutoSync,
				configDirSyncMode: this.plugin.settings.configDirSyncMode ?? 'none',
			})

			await scope.wait(
				waitUntil(
					() => this.plugin.isSyncing === false || scope.signal.aborted,
					500,
				),
			)
			scope.check()

			const sync = new NutstoreSync(this.plugin, {
				vault: guardVault(this.plugin.app.vault, scope.check, scope.track),
				signal: scope.signal,
				token: await scope.wait(this.plugin.getToken()),
				remoteAccountId: await scope.wait(this.plugin.getRemoteAccountId()),
				remoteBaseDir: this.plugin.remoteBaseDir,
				webdav: await this.plugin.sync.webdav.createWebDAVClient(),
			})

			result = await sync.start({
				mode: options.mode,
				syncPolicy,
			})

			return result.ended && !scope.signal.aborted
		} catch (error) {
			if (scope.signal.aborted || isAbortError(error)) return false
			emitSyncError(error as Error)
			logger.error('Sync error:', error)
			return false
		} finally {
			this.inFlight = false
			if (result?.ended && !scope.signal.aborted) {
				if (result.shouldReloadSettings) {
					this.plugin.settingsService.scheduleReloadSettingsFromDisk()
				}
				await this.plugin.sync.gc.runBlobGc().catch((error) => {
					logger.error('Error running auto GC after sync end:', error)
				})
			}
			if (
				!scope.signal.aborted &&
				this.pendingAutoSync &&
				!this.plugin.isSyncing
			) {
				this.pendingAutoSync = false
				void this.executeSync({ mode: SyncStartMode.AUTO_SYNC })
			}
		}
	}
}
