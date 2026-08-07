import type { SyncPreparationProgress } from '~/events'
import i18n from '~/i18n'

export interface SyncPreparationText {
	operation: string
	detail: string
}

export function getSyncPreparationText(
	progress: SyncPreparationProgress,
): SyncPreparationText {
	const traversal = progress.traversal

	switch (progress.phase) {
		case 'checkingRemote':
			return {
				operation: i18n.t('sync.preparation.checkingRemote'),
				detail: '',
			}
		case 'loadingState':
			return {
				operation: i18n.t('sync.preparation.loadingState'),
				detail: '',
			}
		case 'analyzing':
			return {
				operation: i18n.t('sync.preparation.analyzing'),
				detail: '',
			}
		case 'savingCache':
			return {
				operation: i18n.t('sync.preparation.savingCache'),
				detail: '',
			}
		case 'traversingRemote':
			break
	}

	if (!traversal || traversal.phase === 'complete') {
		return {
			operation: i18n.t('sync.preparation.analyzing'),
			detail: '',
		}
	}

	if (traversal.phase === 'retrying') {
		return {
			operation: i18n.t('sync.preparation.retryingRemote'),
			detail: traversal.currentPath ?? '',
		}
	}

	if (traversal.phase === 'incremental') {
		return {
			operation: i18n.t('sync.preparation.checkingChanges'),
			detail: i18n.t('sync.preparation.incrementalStats', {
				changes: traversal.processedChanges,
			}),
		}
	}

	return {
		operation: i18n.t('sync.preparation.scanningRemote'),
		detail: i18n.t('sync.preparation.traversalStats', {
			processed: traversal.processedDirectories,
			queued: traversal.queuedDirectories,
			items: traversal.discoveredItems,
		}),
	}
}
