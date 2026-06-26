import { NutstoreSync, SyncStartMode } from '~/sync'
import { Notice } from 'obsidian'
import { IN_DEV } from '~/consts'
import { emitStopGc, emitSyncError } from '~/events'
import i18n from '~/i18n'
import type { SyncStartResult } from '~/sync'
import logger from '~/utils/logger'
import waitUntil from '~/utils/wait-until'
import type NutstorePlugin from '..'

export interface SyncOptions {
	mode: SyncStartMode
}

export default class SyncExecutorService {
	private inFlight = false

	constructor(private plugin: NutstorePlugin) {}

	isRunning() {
		return this.inFlight || this.plugin.isSyncing
	}

	async executeSync(options: SyncOptions) {
		if (this.isRunning()) {
			new Notice(i18n.t('sync.blockedBySync'))
			return false
		}

		this.inFlight = true

		let result: SyncStartResult | undefined
		try {
			if (this.plugin.gcService.isRunningNow()) {
				if (IN_DEV && options.mode === SyncStartMode.MANUAL_SYNC) {
					new Notice(i18n.t('sync.stoppingGcForSync'))
				}
				emitStopGc()
				await this.plugin.gcService.waitUntilIdle()
			}

			if (!this.plugin.isAccountConfigured()) {
				new Notice(i18n.t('sync.error.accountNotConfigured'))
				return false
			}

			await waitUntil(() => this.plugin.isSyncing === false, 500)

			const sync = new NutstoreSync(this.plugin, {
				vault: this.plugin.app.vault,
				token: await this.plugin.getToken(),
				remoteBaseDir: this.plugin.remoteBaseDir,
				webdav: await this.plugin.webDAVService.createWebDAVClient(),
			})

			result = await sync.start({
				mode: options.mode,
			})

			return result.ended
		} catch (error) {
			emitSyncError(error as Error)
			logger.error('Sync error:', error)
			return false
		} finally {
			this.inFlight = false
			if (result?.ended) {
				if (result.shouldReloadSettings) {
					this.plugin.settingsService.scheduleReloadSettingsFromDisk()
				}
				await this.plugin.gcService.runBlobGc().catch((error) => {
					logger.error('Error running auto GC after sync end:', error)
				})
			}
		}
	}
}
