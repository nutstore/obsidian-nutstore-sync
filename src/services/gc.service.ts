import { Mutex } from 'async-mutex'
import { Notice } from 'obsidian'
import { IN_DEV } from '~/consts'
import { emitGcProgress } from '~/events/gc-progress'
import { onStopGc } from '~/events/gc-stop'
import i18n from '~/i18n'
import { blobKV, syncRecordKV } from '~/storage/kv'
import type NutstorePlugin from '..'

export type GcRunResult =
	| {
			ok: true
			deletedCount: number
	  }
	| {
			ok: false
			reason: 'sync' | 'gc' | 'cancelled'
	  }

export default class GcService {
	private lock = new Mutex()
	private stopRequested = false

	constructor(private plugin: NutstorePlugin) {}

	isRunningNow() {
		return this.lock.isLocked()
	}

	async waitUntilIdle(): Promise<void> {
		if (!this.lock.isLocked()) {
			return
		}
		await this.lock.waitForUnlock()
	}

	async runBlobGc(): Promise<GcRunResult> {
		if (this.plugin.syncExecutorService.isRunning()) {
			if (IN_DEV) {
				new Notice(i18n.t('settings.cache.gcBlockedBySync'))
			}
			return { ok: false, reason: 'sync' }
		}

		if (this.lock.isLocked()) {
			if (IN_DEV) {
				new Notice(i18n.t('settings.cache.gcBlockedByGc'))
			}
			return { ok: false, reason: 'gc' }
		}

		const release = await this.lock.acquire()
		this.stopRequested = false
		const stopSub = onStopGc().subscribe(() => {
			this.stopRequested = true
		})
		try {
			const start = globalThis.performance?.now?.() ?? Date.now()
			let stoppedEarly = false
			const deletedCount = await collectBlobGarbage(emitGcProgress, () => {
				if (this.stopRequested) {
					stoppedEarly = true
					return true
				}
				return false
			})
			const durationMs = (globalThis.performance?.now?.() ?? Date.now()) - start
			console.table([
				{
					event: 'blob gc completed',
					deletedCount,
					durationMs: Number(durationMs.toFixed(2)),
				},
			])
			if (stoppedEarly) {
				return {
					ok: false,
					reason: 'cancelled',
				}
			}
			return {
				ok: true,
				deletedCount,
			}
		} finally {
			this.stopRequested = false
			stopSub.unsubscribe()
			release()
		}
	}
}

export async function collectBlobGarbage(
	onProgress?: (current: number, total: number) => void,
	shouldStop?: () => boolean,
): Promise<number> {
	const usedKeys = new Set<string>()
	const namespaceKeys = await syncRecordKV.keys()
	for (const ns of namespaceKeys) {
		const recordMap = await syncRecordKV.get(ns)
		if (!recordMap) continue
		for (const record of recordMap.values()) {
			if (record.base?.key) {
				usedKeys.add(record.base.key)
			}
		}
	}

	const allBlobKeys = await blobKV.keys()
	const total = allBlobKeys.length
	let deletedCount = 0
	for (let i = 0; i < allBlobKeys.length; i++) {
		if (shouldStop?.()) {
			break
		}
		const key = allBlobKeys[i]
		if (!usedKeys.has(key)) {
			await blobKV.unset(key)
			deletedCount++
		}
		onProgress?.(i + 1, total)
	}
	return deletedCount
}
