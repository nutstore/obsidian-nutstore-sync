import { throttle } from 'lodash-es'
import { Notice } from 'obsidian'
import SyncProgressModal from '../components/SyncProgressModal'
import {
	onEndSync,
	onPreparingSync,
	onStartSync,
	onSyncProgress,
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

	syncEnd = false

	private subscriptions: { unsubscribe: () => void }[] = []

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override onload() {
		this.onunload()
		this.subscriptions = [
			onPreparingSync().subscribe(() => {
				this.syncEnd = false
				this.resetProgress()
			}),
			onStartSync().subscribe(() => {
				this.syncEnd = false
				this.resetProgress()
			}),
			onEndSync().subscribe(() => {
				this.syncEnd = true
				this.updateModal()
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
