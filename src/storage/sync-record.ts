import { SyncRecordModel } from '~/model/sync-record.model'
import { UseStorageType } from './use-storage'

export class SyncRecord {
	constructor(
		private namespace: string,
		private storage: UseStorageType<Map<string, SyncRecordModel>>,
	) {}

	async batchDelete(paths: readonly string[]): Promise<void> {
		if (paths.length === 0) {
			return
		}
		const map = await this.storage.get(this.namespace)
		if (!map) {
			return
		}
		let deleted = false
		for (const path of paths) {
			if (map.delete(path)) {
				deleted = true
			}
		}
		if (deleted) {
			await this.storage.set(this.namespace, map)
		}
	}

	async getRecords(): Promise<Map<string, SyncRecordModel>> {
		const map = await this.storage.get(this.namespace)
		return map ?? new Map()
	}

	async setRecords(records: Map<string, SyncRecordModel>) {
		await this.storage.set(this.namespace, records)
	}

	async getRecord(path: string): Promise<SyncRecordModel | undefined> {
		const map = await this.storage.get(this.namespace)
		if (map) {
			return map.get(path)
		}
	}
}
