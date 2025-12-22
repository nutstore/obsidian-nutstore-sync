import { debounce } from 'lodash-es'
import { useSettings } from '~/settings'
import { SyncStartMode } from '~/sync'
import waitUntil from '~/utils/wait-until'
import NutstorePlugin from '..'
import type SyncExecutorService from './sync-executor.service'

export default class RealtimeSyncService {
	private waiting = false

	private submitDirectly = async () => {
		if (this.waiting) {
			return
		}
		this.waiting = true
		await waitUntil(() => this.plugin.isSyncing === false, 500)
		this.waiting = false
		await this.syncExecutor.executeSync({ mode: SyncStartMode.AUTO_SYNC })
	}

	private submitSyncRequest = debounce(this.submitDirectly, 8000)

	constructor(
		private plugin: NutstorePlugin,
		private syncExecutor: SyncExecutorService,
	) {
		this.plugin.registerEvent(
			this.vault.on('create', async () => {
				const settings = await useSettings()
				if (!settings.realtimeSync) {
					return
				}
				await this.submitSyncRequest()
			}),
		)
		this.plugin.registerEvent(
			this.vault.on('delete', async () => {
				const settings = await useSettings()
				if (!settings.realtimeSync) {
					return
				}
				await this.submitSyncRequest()
			}),
		)
		this.plugin.registerEvent(
			this.vault.on('modify', async () => {
				const settings = await useSettings()
				if (!settings.realtimeSync) {
					return
				}
				await this.submitSyncRequest()
			}),
		)
		this.plugin.registerEvent(
			this.vault.on('rename', async () => {
				const settings = await useSettings()
				if (!settings.realtimeSync) {
					return
				}
				await this.submitSyncRequest()
			}),
		)
	}

	get vault() {
		return this.plugin.app.vault
	}

	unload() {
		this.submitSyncRequest.cancel()
	}
}
