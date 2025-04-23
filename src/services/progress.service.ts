import { throttle } from 'lodash-es'
import { Notice } from 'obsidian'
import SyncProgressModal from '../components/SyncProgressModal'
import { UpdateSyncProgress } from '../events'
import i18n from '../i18n'
import NutstorePlugin from '../index'

export class ProgressService {
	private progressModal: SyncProgressModal | null = null

	public syncProgress: UpdateSyncProgress = {
		total: 0,
		completed: [],
	}

	constructor(private plugin: NutstorePlugin) {}

	updateProgress = throttle((progress: UpdateSyncProgress): void => {
		this.syncProgress = progress
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
		this.closeProgressModal()
	}
}
