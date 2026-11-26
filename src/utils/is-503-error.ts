import {
	extractHttpStatus,
	extractNutstoreDavException,
} from './nutstore-dav-error'

const LEGACY_503_MESSAGE = 'Invalid response: 503 Service Unavailable'

/**
 * Identifies transient Nutstore 503 / `ServiceUnAvailable` throttling across
 * `webdav` client errors, `requestUrl` failures, and wrapped `TaskError`s.
 */
export function is503Error(error: unknown): boolean {
	if (error === LEGACY_503_MESSAGE) {
		return true
	}
	if (error instanceof Error && error.message === LEGACY_503_MESSAGE) {
		return true
	}
	if (extractHttpStatus(error) === 503) {
		return true
	}
	if (extractNutstoreDavException(error) === 'ServiceUnAvailable') {
		return true
	}
	return false
}
