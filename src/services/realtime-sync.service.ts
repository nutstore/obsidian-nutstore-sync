import { debounce } from 'lodash-es'

import { useSettings } from '~/settings'
import waitUntil from '~/utils/wait-until'
import NutstorePlugin from '..'
import type SyncExecutorService from './sync-executor.service'

export default class RealtimeSyncService {
	async realtimeSync() {
		const settings = await useSettings()
		if (!settings.realtimeSync) {
			return
		}
		await this.syncExecutor.executeSync({ showNotice: false })
	}

	submitSyncRequest = new (class {
		waiting = false

		constructor(public realtimeSyncService: RealtimeSyncService) {}

		submitDirectly = async () => {
			if (this.waiting) {
				return
			}
			this.waiting = true
			await waitUntil(
				() => this.realtimeSyncService.plugin.isSyncing === false,
				500,
			)
			this.waiting = false
			await this.realtimeSyncService.realtimeSync()
		}

		submit = debounce(this.submitDirectly, 8000)
	})(this)

	constructor(
		private plugin: NutstorePlugin,
		private syncExecutor: SyncExecutorService,
	) {
		this.plugin.registerEvent(
			this.vault.on('create', async () => {
				await this.submitSyncRequest.submit()
			}),
		)
		this.plugin.registerEvent(
			this.vault.on('delete', async () => {
				await this.submitSyncRequest.submit()
			}),
		)
		this.plugin.registerEvent(
			this.vault.on('modify', async () => {
				await this.submitSyncRequest.submit()
			}),
		)
		this.plugin.registerEvent(
			this.vault.on('rename', async () => {
				await this.submitSyncRequest.submit()
			}),
		)
	}

	get vault() {
		return this.plugin.app.vault
	}
}
