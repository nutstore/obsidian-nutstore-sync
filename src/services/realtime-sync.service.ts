import { debounce } from 'es-toolkit/compat'
import { SyncStartMode } from '~/sync'
import { BaseService } from './service.interface'
import type NutstorePlugin from '..'
import type SyncExecutorService from './sync-executor.service'

/** The executor already coalesces requests arriving while synchronization runs. */
export default class RealtimeSyncService extends BaseService {
	private dispose?: () => void
	constructor(
		private plugin: NutstorePlugin,
		private syncExecutor: SyncExecutorService,
	) {
		super()
	}
	override onload() {
		this.onunload()
		const scope = this.plugin.sync.lifecycle.scope
		// Initial vault loading emits create events; only user changes should trigger sync.
		this.plugin.app.workspace.onLayoutReady(() => {
			if (scope.signal.aborted) return
			const submit = debounce(() => {
				if (!scope.signal.aborted && this.plugin.settings.realtimeSync)
					void this.syncExecutor.executeSync({ mode: SyncStartMode.AUTO_SYNC })
			}, 8000)
			const vault = this.plugin.app.vault
			const changed = () => {
				if (!scope.signal.aborted && this.plugin.settings.realtimeSync) submit()
			}
			const events = [
				vault.on('create', changed),
				vault.on('delete', changed),
				vault.on('modify', changed),
				vault.on('rename', changed),
			]
			this.dispose = () => {
				submit.cancel()
				events.forEach((event) => vault.offref(event))
			}
		})
	}
	override onunload() {
		this.dispose?.()
		this.dispose = undefined
	}
}
