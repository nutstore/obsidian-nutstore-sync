import { Notice } from 'obsidian'
import { Subscription } from 'rxjs'
import { onEndSync, onStartSync, onSyncError, onSyncProgress } from '~/events'
import i18n from '~/i18n'
import { is503Error } from '~/utils/is-503-error'
import NutstorePlugin from '..'

export default class EventsService {
	subscriptions: Subscription[]

	constructor(private plugin: NutstorePlugin) {
		this.subscriptions = [
			onStartSync().subscribe(() => {
				plugin.toggleSyncUI(true)
				plugin.statusService.updateSyncStatus({
					text: i18n.t('sync.start'),
					showNotice: true,
				})
			}),

			onSyncProgress().subscribe((progress) => {
				const percent =
					Math.round((progress.completed.length / progress.total) * 10000) / 100
				plugin.statusService.updateSyncStatus({
					text: i18n.t('sync.progress', { percent }),
				})
			}),

			onEndSync().subscribe(async (failedCount) => {
				plugin.toggleSyncUI(false)
				plugin.statusService.updateSyncStatus({
					text:
						failedCount > 0
							? i18n.t('sync.completeWithFailed', { failedCount })
							: i18n.t('sync.complete'),
					showNotice: true,
					hideAfter: 3000,
				})
			}),

			onSyncError().subscribe((error) => {
				plugin.toggleSyncUI(false)
				plugin.statusService.updateSyncStatus({
					text: i18n.t('sync.failedStatus'),
					isError: true,
					showNotice: false,
					hideAfter: 3000,
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
