import SyncConfirmModal from '~/components/SyncConfirmModal'
import { emitCancelSync } from '~/events'
import i18n from '~/i18n'
import { NutstoreSync } from '~/sync'
import NutstorePlugin from '..'

export default class CommandService {
	constructor(plugin: NutstorePlugin) {
		plugin.addCommand({
			id: 'start-sync',
			name: i18n.t('sync.startButton'),
			checkCallback: (checking) => {
				if (plugin.isSyncing) {
					return false
				}
				if (checking) {
					return true
				}
				const startSync = async () => {
					const sync = new NutstoreSync(plugin, {
						webdav: await plugin.webDAVService.createWebDAVClient(),
						vault: plugin.app.vault,
						token: await plugin.getToken(),
						remoteBaseDir: plugin.remoteBaseDir,
					})
					await sync.start({
						showNotice: true,
					})
				}
				if (plugin.settings.confirmBeforeSync) {
					new SyncConfirmModal(plugin.app, startSync).open()
				} else {
					startSync()
				}
			},
		})

		plugin.addCommand({
			id: 'stop-sync',
			name: i18n.t('sync.stopButton'),
			checkCallback: (checking) => {
				if (plugin.isSyncing) {
					if (!checking) {
						emitCancelSync()
					}
					return true
				}
				return false
			},
		})

		plugin.addCommand({
			id: 'show-sync-progress',
			name: i18n.t('sync.showProgressButton'),
			callback: () => {
				plugin.progressService.showProgressModal()
			},
		})
	}
}
