import { parse as bytesParse } from 'bytes-iec'
import { isNil } from 'lodash-es'
import { isNotNil } from 'ramda'
import { isNumeric } from './is-numeric'

export const DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE = '16 MiB'
export const MIN_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES = bytesParse('64 KiB', {
	mode: 'jedec',
})!
export const MAX_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES = bytesParse('64 MiB', {
	mode: 'jedec',
})!

export function normalizeByteSizeInput(value: string, fallback: string) {
	let normalized = value.trim()
	if (!normalized) {
		return fallback
	}
	if (
		isNumeric(normalized) ||
		(isNil(bytesParse(normalized)) && isNotNil(bytesParse(normalized + 'B')))
	) {
		normalized += 'B'
	}
	return normalized
}

export function parseMobileAppDownloadFileChunkSize(value: string | undefined) {
	const normalized = normalizeByteSizeInput(
		value ?? '',
		DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE,
	)
	const parsed = bytesParse(normalized, { mode: 'jedec' })
	if (parsed === null) {
		return bytesParse(DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE, {
			mode: 'jedec',
		})!
	}
	return Math.min(
		MAX_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES,
		Math.max(MIN_MOBILE_APP_DOWNLOAD_FILE_CHUNK_BYTES, parsed),
	)
}
