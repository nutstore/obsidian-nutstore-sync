import { Notice } from 'obsidian'
import { Subscription } from 'rxjs'
import {
	onEndSync,
	onPreparingSync,
	onStartSync,
	onSyncCancelled,
	onSyncPreparationProgress,
	onSyncError,
	onSyncProgress,
} from '~/events'
import ScanIssuesModal from '~/components/ScanIssuesModal'
import i18n from '~/i18n'
import type { ScanIssue } from '~/sync/scope'
import { LocalScanError } from '~/utils/local-scan-error'
import { describeSyncError } from '~/utils/describe-sync-error'
import { getSyncPreparationText } from '~/utils/sync-preparation-text'
import { BaseService } from './service.interface'
import NutstorePlugin from '..'

export default class EventsService extends BaseService {
	subscriptions: Subscription[] = []
	private scanIssuesModal?: ScanIssuesModal

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	/** One modal at a time: a later sync refreshes the open list instead of stacking. */
	showScanIssues(issues: readonly ScanIssue[]) {
		if (this.scanIssuesModal?.modalEl.isConnected) {
			this.scanIssuesModal.update(issues)
			return
		}
		this.scanIssuesModal = new ScanIssuesModal(this.plugin.app, issues)
		this.scanIssuesModal.open()
	}

	override onload() {
		this.onunload()
		this.subscriptions = [
			onPreparingSync().subscribe(({ showNotice }) => {
				this.plugin.toggleSyncUI(true)
				this.plugin.sync.status.updateSyncStatus({
					text: i18n.t('sync.preparing'),
					showNotice,
				})
			}),

			onSyncPreparationProgress().subscribe((progress) => {
				this.plugin.sync.status.updateSyncStatus({
					text: getSyncPreparationText(progress).operation,
				})
			}),

			onStartSync().subscribe(({ showNotice }) => {
				this.plugin.sync.status.updateSyncStatus({
					text: i18n.t('sync.start'),
					showNotice,
				})
			}),

			onSyncProgress().subscribe((progress) => {
				const percent =
					Math.round((progress.completed.length / progress.total) * 10000) / 100
				this.plugin.sync.status.updateSyncStatus({
					text: i18n.t('sync.progress', { percent }),
				})
			}),

			onSyncCancelled().subscribe(() => {
				this.plugin.toggleSyncUI(false)
				this.plugin.sync.status.updateSyncStatus({
					text: i18n.t('sync.cancelled'),
				})
			}),

			onEndSync().subscribe(({ failedCount, showNotice, scanIssues = [] }) => {
				this.plugin.toggleSyncUI(false)
				const now = Date.now()
				this.plugin.sync.status.setLastSyncTime(
					now,
					failedCount + scanIssues.length,
				)
				const progressVisible = this.plugin.sync.progress.hasVisibleSyncModal()
				if (scanIssues.length > 0) {
					// A visible progress modal already summarizes the skipped paths and
					// offers a button for the list; only interrupt when it is hidden.
					if (!progressVisible) this.showScanIssues(scanIssues)
				} else if (showNotice && !progressVisible) {
					const text =
						failedCount > 0
							? i18n.t('sync.completeWithFailed', { failedCount })
							: i18n.t('sync.complete')
					new Notice(text)
				}
			}),

			onSyncError().subscribe((error) => {
				this.plugin.toggleSyncUI(false)
				this.plugin.sync.status.updateSyncStatus({
					text: i18n.t('sync.failedStatus'),
					isError: true,
					showNotice: false,
				})
				if (error instanceof LocalScanError) {
					const hasAutomaticRetry =
						this.plugin.settings.autoSyncIntervalSeconds > 0
					new Notice(
						i18n.t(
							hasAutomaticRetry
								? 'sync.incompleteScanAutoRetry'
								: 'sync.incompleteScanManualRetry',
						),
						10_000,
					)
				} else {
					new Notice(
						i18n.t('sync.failedWithError', {
							error: describeSyncError(error),
						}),
					)
				}
			}),
		]
	}

	override onunload() {
		this.scanIssuesModal?.close()
		this.scanIssuesModal = undefined
		this.subscriptions.forEach((subscription) => subscription.unsubscribe())
		this.subscriptions = []
	}
}
