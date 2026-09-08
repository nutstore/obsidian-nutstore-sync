import { throttle } from 'lodash-es'
import { Notice } from 'obsidian'
import SyncProgressModal from '../components/SyncProgressModal'
import {
	onEndSync,
	onPreparingSync,
	onStartSync,
	onSyncCancelled,
	onSyncError,
	onSyncPreparationProgress,
	onSyncProgress,
	type SyncPreparationProgress,
	UpdateSyncProgress,
} from '../events'
import i18n from '../i18n'
import NutstorePlugin from '../index'
import { BaseService } from './service.interface'

export class ProgressService extends BaseService {
	private progressModal: SyncProgressModal | null = null

	public syncProgress: UpdateSyncProgress = {
		total: 0,
		completed: [],
		current: null,
	}
	public preparationProgress: SyncPreparationProgress | null = null

	syncEnd = false
	syncFailed = false
	syncFailedCount = 0

	private subscriptions: { unsubscribe: () => void }[] = []

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override onload() {
		this.onunload()
		this.subscriptions = [
			onPreparingSync().subscribe(() => {
				this.syncEnd = false
				this.syncFailed = false
				this.syncFailedCount = 0
				this.resetProgress()
				this.preparationProgress = { phase: 'checkingRemote' }
				this.updateModal()
			}),
			onSyncPreparationProgress().subscribe((progress) => {
				this.preparationProgress = progress
				this.updateModal()
			}),
			onStartSync().subscribe(() => {
				this.preparationProgress = null
			}),
			onEndSync().subscribe(({ failedCount }) => {
				this.syncEnd = true
				this.syncFailedCount = failedCount
				this.preparationProgress = null
				this.updateModal()
			}),
			onSyncError().subscribe(() => {
				this.syncFailed = true
				this.preparationProgress = null
				this.updateModal()
			}),
			onSyncCancelled().subscribe(() => {
				this.preparationProgress = null
				this.closeProgressModal()
			}),
			onSyncProgress().subscribe((p) => {
				this.syncProgress = p
				this.updateModal()
			}),
		]
	}

	updateModal = throttle(() => {
		if (this.progressModal) {
			this.progressModal.update()
		}
	}, 200)

	public resetProgress() {
		this.syncProgress = {
			total: 0,
			completed: [],
			current: null,
		}
	}

	public showProgressModal() {
		if (!this.plugin.isSyncing) {
			new Notice(i18n.t('sync.notSyncing'))
			return
		}
		if (this.progressModal) {
			this.updateModal()
			return
		}
		this.closeProgressModal()
		this.progressModal = new SyncProgressModal(this.plugin, () => {
			this.progressModal = null
		})
		this.progressModal.open()
	}

	public hasVisibleSyncModal(): boolean {
		return this.progressModal !== null
	}

	public closeProgressModal() {
		if (this.progressModal) {
			this.progressModal.close()
			this.progressModal = null
		}
	}

	override onunload() {
		this.subscriptions.forEach((sub) => sub.unsubscribe())
		this.subscriptions = []
		this.closeProgressModal()
	}
}
