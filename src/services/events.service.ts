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
import i18n from '~/i18n'
import { LocalScanError } from '~/utils/local-scan-error'
import { describeSyncError } from '~/utils/describe-sync-error'
import { getSyncPreparationText } from '~/utils/sync-preparation-text'
import { BaseService } from './service.interface'
import NutstorePlugin from '..'

export default class EventsService extends BaseService {
	subscriptions: Subscription[] = []

	constructor(private plugin: NutstorePlugin) {
		super()
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
					Math.round((progress.completedCount / progress.total) * 10000) / 100
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

			// How the outcome is presented belongs to the progress service.
			onEndSync().subscribe(({ failedCount, scanIssues = [] }) => {
				this.plugin.toggleSyncUI(false)
				this.plugin.sync.status.setLastSyncTime(
					Date.now(),
					failedCount + scanIssues.length,
				)
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
		this.subscriptions.forEach((subscription) => subscription.unsubscribe())
		this.subscriptions = []
	}
}
