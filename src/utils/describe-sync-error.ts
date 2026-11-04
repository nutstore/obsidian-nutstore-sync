import i18n from '~/i18n'
import { is503Error } from './is-503-error'

/** One reading of a sync failure for every surface that reports it. */
export function describeSyncError(error: Error): string {
	return is503Error(error)
		? i18n.t('sync.error.requestsTooFrequent')
		: error.message
}
