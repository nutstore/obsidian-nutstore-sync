export function formatDuration(durationMs: number) {
	const milliseconds = Math.max(0, Math.round(durationMs))
	if (milliseconds < 1000) return `${milliseconds}ms`
	const seconds = Math.floor(milliseconds / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	if (minutes < 60)
		return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	return `${hours}h ${String(remainingMinutes).padStart(2, '0')}m`
}
