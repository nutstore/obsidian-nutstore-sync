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

export function formatLocalTimestampForFilename(date: Date) {
	return `${formatLocalDate(date)}T${[
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
		pad(date.getMilliseconds(), 3),
	].join('-')}`
}
