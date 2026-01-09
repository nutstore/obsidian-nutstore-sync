import i18n from '~/i18n'

export function formatRelativeTime(timestamp: number): string {
	const now = Date.now()
	const diffMs = now - timestamp
	const diffSeconds = Math.floor(diffMs / 1000)
	const diffMinutes = Math.floor(diffSeconds / 60)
	const diffHours = Math.floor(diffMinutes / 60)
	const diffDays = Math.floor(diffHours / 24)

	if (diffSeconds < 60) {
		return i18n.t('time.justNow')
	} else if (diffMinutes < 60) {
		return i18n.t('time.minutesAgo', { count: diffMinutes })
	} else if (diffHours < 24) {
		return i18n.t('time.hoursAgo', { count: diffHours })
	} else if (diffDays < 30) {
		return i18n.t('time.daysAgo', { count: diffDays })
	} else {
		return i18n.t('time.longAgo')
	}
}
