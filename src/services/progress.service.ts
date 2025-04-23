import { throttle } from 'lodash-es'
import { Notice } from 'obsidian'
import SyncProgressModal from '../components/SyncProgressModal'
import {
	onEndSync,
	onStartSync,
	onSyncProgress,
	UpdateSyncProgress,
} from '../events'
import i18n from '../i18n'
import NutstorePlugin from '../index'

export class ProgressService {
	private progressModal: SyncProgressModal | null = null

	public syncProgress: UpdateSyncProgress = {
		total: 0,
		completed: [],
	}

	syncEnd = false

	private subscriptions = [
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

	constructor(private plugin: NutstorePlugin) {}

	updateModal = throttle(() => {
		if (this.progressModal) {
			this.progressModal.update()
		}
	}, 200)

	public resetProgress() {
		this.syncProgress = {
			total: 0,
			completed: [],
		}
	}

	public showProgressModal() {
		if (!this.plugin.isSyncing) {
			new Notice(i18n.t('sync.notSyncing'))
			return
		}
		this.closeProgressModal()
		this.progressModal = new SyncProgressModal(this.plugin)
		this.progressModal.open()
	}

	public closeProgressModal() {
		if (this.progressModal) {
			this.progressModal.close()
			this.progressModal = null
		}
	}

	public unload() {
		this.subscriptions.forEach((sub) => sub.unsubscribe())
		this.closeProgressModal()
	}
}
