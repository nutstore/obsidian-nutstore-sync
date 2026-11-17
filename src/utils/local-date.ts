function pad(value: number, length = 2) {
	return String(value).padStart(length, '0')
}

export function formatLocalDate(date: Date) {
	return [
		pad(date.getFullYear(), 4),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
	].join('-')
}

/**
 * Local wall-clock date and time ('YYYY-MM-DD HH:mm:ss'), the timestamp shown
 * in the in-app log buffer and in saved log notes.
 *
 * Uses local calendar fields on purpose: users correlate logs with their own
 * clock, not with UTC.
 */
export function formatLocalTimestamp(date: Date) {
	const time = [
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join(':')
	return `${formatLocalDate(date)} ${time}`
}

export function formatLocalTimestampForFilename(date: Date) {
	return `${formatLocalDate(date)}T${[
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
		pad(date.getMilliseconds(), 3),
	].join('-')}`
}
