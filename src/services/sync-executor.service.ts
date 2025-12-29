import { syncRecordKV } from '~/storage'
import { SyncRecord } from '~/storage/sync-record'
import { NutstoreSync, SyncStartMode } from '~/sync'
import TwoWaySyncDecider from '~/sync/decision/two-way.decider'
import { getSyncRecordNamespace } from '~/utils/get-sync-record-namespace'
import waitUntil from '~/utils/wait-until'
import type NutstorePlugin from '..'

export interface SyncOptions {
	mode: SyncStartMode
}

export default class SyncExecutorService {
	constructor(private plugin: NutstorePlugin) {}

	async executeSync(options: SyncOptions) {
		if (this.plugin.isSyncing) {
			return false
		}

		await waitUntil(() => this.plugin.isSyncing === false, 500)

		// 确保 configDir 始终在排除列表中，因为这个目录里的文件不支持同步
		const configDir = this.plugin.app.vault.configDir
		const hasConfigDirRule = this.plugin.settings.filterRules.exclusionRules.some(
			(rule) => rule.expr === configDir
		)
		if (!hasConfigDirRule) {
			this.plugin.settings.filterRules.exclusionRules.push({
				expr: configDir,
				options: { caseSensitive: false },
			})
			await this.plugin.saveSettings()
		}

		const sync = new NutstoreSync(this.plugin, {
			vault: this.plugin.app.vault,
			token: await this.plugin.getToken(),
			remoteBaseDir: this.plugin.remoteBaseDir,
			webdav: await this.plugin.webDAVService.createWebDAVClient(),
		})

		const syncRecord = new SyncRecord(
			getSyncRecordNamespace(
				this.plugin.app.vault.getName(),
				this.plugin.remoteBaseDir,
			),
			syncRecordKV,
		)

		const decider = new TwoWaySyncDecider(sync, syncRecord)
		const decided = await decider.decide()

		if (decided.length === 0) {
			return false
		}

		await sync.start({
			mode: options.mode,
		})

		return true
	}
}
