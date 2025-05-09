import { debounce } from 'lodash-es'
import { useSettings } from '~/settings'
import { NutstoreSync } from '~/sync'
import sleep from '~/utils/sleep'
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
		await sync.start({
			showNotice: false,
		})
	}

	submitSyncRequest = new (class {
		waiting = false

		constructor(public realtimeSyncService: RealtimeSyncService) {}

		submit = debounce(async () => {
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
		}, 8000)
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

		this.startIntervalSync()
	}

	async startIntervalSync() {
		while (true) {
			await sleep(30000)
			await waitUntil(
				async () =>
					this.plugin.isSyncing === false &&
					Date.now() - this.plugin.lastSyncAt > 10 * 60 * 1000,
				1000,
			)
			await this.realtimeSync()
		}
	}

	get vault() {
		return this.plugin.app.vault
	}
}
