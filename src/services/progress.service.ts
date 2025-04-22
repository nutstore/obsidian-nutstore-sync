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

	public updateProgress(progress: UpdateSyncProgress): void {
		this.syncProgress = progress
		if (this.progressModal) {
			this.progressModal.update()
		}
	}

	// Reset progress data
	public resetProgress(): void {
		this.syncProgress = {
			total: 0,
			completed: [],
		}
	}

	public showProgressModal(): void {
		if (!this.plugin.isSyncing) {
			new Notice(i18n.t('sync.notSyncing'))
			return
		}

		// Close existing modal if it's open
		this.closeProgressModal()

		this.progressModal = new SyncProgressModal(this.plugin)
		this.progressModal.open()
	}

	public closeProgressModal(): void {
		if (this.progressModal) {
			this.progressModal.close()
			this.progressModal = null
		}
	}

	public unload(): void {
		this.closeProgressModal()
	}
}
