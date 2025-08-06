import { SyncRecordModel } from '~/model/sync-record.model'
import { UseStorageType } from './use-storage'

export class SyncRecord {
	constructor(
		private namespace: string,
		private storage: UseStorageType<Map<string, SyncRecordModel>>,
	) {}

	async updateFileRecord(path: string, record: SyncRecordModel): Promise<void> {
		const map = await this.storage.get(this.namespace)
		if (map) {
			map.set(path, record)
			await this.storage.set(this.namespace, map)
		} else {
			await this.storage.set(this.namespace, new Map([[path, record]]))
		}
	}

	async deleteFileRecord(path: string): Promise<void> {
		const map = await this.storage.get(this.namespace)
		if (map) {
			if (map.has(path)) {
				map.delete(path)
				await this.storage.set(this.namespace, map)
			}
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

	async drop() {
		await this.storage.unset(this.namespace)
	}

	async exists(path: string): Promise<boolean> {
		const map = await this.storage.get(this.namespace)
		if (map) {
			return map.has(path)
		}
		return false
	}

	async batchUpdate(updates: [string, SyncRecordModel][]): Promise<void> {
		if (updates.length === 0) {
			return
		}
		const map = await this.storage.get(this.namespace)

		if (map) {
			for (const [path, record] of updates) {
				map.set(path, record)
			}
			await this.storage.set(this.namespace, map)
		} else {
			await this.storage.set(this.namespace, new Map(updates))
		}
	}
}
