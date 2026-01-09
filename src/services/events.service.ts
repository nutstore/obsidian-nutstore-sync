import { Notice } from 'obsidian'
import { Subscription } from 'rxjs'
import {
	onEndSync,
	onPreparingSync,
	onStartSync,
	onSyncError,
	onSyncProgress,
} from '~/events'
import i18n from '~/i18n'
import { is503Error } from '~/utils/is-503-error'
import NutstorePlugin from '..'

export default class EventsService {
	subscriptions: Subscription[]

	constructor(private plugin: NutstorePlugin) {
		this.subscriptions = [
			onPreparingSync().subscribe(({ showNotice }) => {
				plugin.toggleSyncUI(true)
				plugin.statusService.updateSyncStatus({
					text: i18n.t('sync.preparing'),
					showNotice,
				})
			}),

			onStartSync().subscribe(({ showNotice }) => {
				plugin.statusService.updateSyncStatus({
					text: i18n.t('sync.start'),
					showNotice,
				})
			}),

			onSyncProgress().subscribe((progress) => {
				const percent =
					Math.round((progress.completed.length / progress.total) * 10000) / 100
				plugin.statusService.updateSyncStatus({
					text: i18n.t('sync.progress', { percent }),
				})
			}),

			onEndSync().subscribe(async ({ failedCount, showNotice }) => {
				plugin.toggleSyncUI(false)
				const now = Date.now()
				plugin.statusService.setLastSyncTime(now, failedCount)
				if (showNotice) {
					const text = failedCount > 0
						? i18n.t('sync.completeWithFailed', { failedCount })
						: i18n.t('sync.complete')
					new Notice(text)
				}
			}),

			onSyncError().subscribe((error) => {
				plugin.toggleSyncUI(false)
				plugin.statusService.updateSyncStatus({
					text: i18n.t('sync.failedStatus'),
					isError: true,
					showNotice: false,
				})
				new Notice(
					i18n.t('sync.failedWithError', {
						error: is503Error(error)
							? i18n.t('sync.error.requestsTooFrequent')
							: error.message,
					}),
				)
			}),
		]
	}

	unload() {
		this.subscriptions.forEach((subscription) => subscription.unsubscribe())
	}
}
