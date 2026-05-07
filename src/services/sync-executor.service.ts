import { NutstoreSync, SyncStartMode } from '~/sync'
import waitUntil from '~/utils/wait-until'
import type NutstorePlugin from '..'

export interface SyncOptions {
	mode: SyncStartMode
}

export default class SyncExecutorService {
	private inFlight = false

	constructor(private plugin: NutstorePlugin) {}

	async executeSync(options: SyncOptions) {
		if (this.inFlight || this.plugin.isSyncing) {
			return false
		}
		this.inFlight = true

		try {
			// 检查账号配置，未配置时静默返回（自动同步场景）
			if (!this.plugin.isAccountConfigured()) {
				return false
			}

			await waitUntil(() => this.plugin.isSyncing === false, 500)

			const sync = new NutstoreSync(this.plugin, {
				vault: this.plugin.app.vault,
				token: await this.plugin.getToken(),
				remoteBaseDir: this.plugin.remoteBaseDir,
				webdav: await this.plugin.webDAVService.createWebDAVClient(),
			})

			return await sync.start({
				mode: options.mode,
			})
		} finally {
			this.inFlight = false
		}
	}
}
