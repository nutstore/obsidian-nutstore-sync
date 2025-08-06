import { debounce } from 'lodash-es'
import { useSettings } from '~/settings'
import { SyncRecord } from '~/storage/sync-record'
import { NutstoreSync } from '~/sync'
import TwoWaySyncDecision from '~/sync/decision/two-way.decision'
import waitUntil from '~/utils/wait-until'
import NutstorePlugin from '..'

export default class RealtimeSyncService {
	async realtimeSync() {
		const settings = await useSettings()
		if (!settings.realtimeSync) {
			return
		}
		const sync = new NutstoreSync(this.plugin, {
			vault: this.vault,
			token: await this.plugin.getToken(),
			remoteBaseDir: this.plugin.remoteBaseDir,
			webdav: await this.plugin.webDAVService.createWebDAVClient(),
		})
		const syncRecord = new SyncRecord(this.vault, this.plugin.remoteBaseDir)
		const decider = new TwoWaySyncDecision(sync, syncRecord)
		const decided = await decider.decide()
		if (decided.length === 0) {
			return
		}
		await sync.start({
			showNotice: false,
		})
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

	constructor(private plugin: NutstorePlugin) {
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

		useSettings().then(({ startupSyncDelaySeconds }) => {
			if (startupSyncDelaySeconds > 0) {
				window.setTimeout(() => {
					this.submitSyncRequest.submitDirectly()
				}, startupSyncDelaySeconds * 1000)
			}
		})
	}

	get vault() {
		return this.plugin.app.vault
	}
}
