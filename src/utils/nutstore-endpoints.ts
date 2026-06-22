import { DEFAULT_NS_DAV_ENDPOINT, DEFAULT_NS_NSDAV_ENDPOINT } from '~/consts'
import type { NutstoreSettings } from '~/settings'

const URL_SCHEME_REGEX = /^[a-z][a-z\d+\-.]*:\/\//i
const URL_SCHEME_PREFIX_REGEX = /^[a-z][a-z\d+\-.]*:/i
const UNSAFE_URL_WHITESPACE_REGEX = /[\t\r\n]/
const DOMAIN_LIKE_BASE_URL_REGEX =
	/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::\d{1,5})?(?:[/?#].*)?$/i

export type NutstoreBaseUrlValidationReason =
	| 'invalidFormat'
	| 'unsupportedProtocol'

export class NutstoreBaseUrlValidationError extends Error {
	constructor(public readonly reason: NutstoreBaseUrlValidationReason) {
		super(reason)
		this.name = 'NutstoreBaseUrlValidationError'
	}
}

function trimTrailingSlash(value: string) {
	return value.replace(/\/+$/, '')
}

function getUrlCandidate(value: string) {
	if (URL_SCHEME_REGEX.test(value)) {
		return value
	}
	if (DOMAIN_LIKE_BASE_URL_REGEX.test(value)) {
		return `https://${value}`
	}
	return value
}

export function normalizeNutstoreBaseUrl(value: string) {
	const trimmed = value.trim()
	if (UNSAFE_URL_WHITESPACE_REGEX.test(trimmed)) {
		throw new NutstoreBaseUrlValidationError('invalidFormat')
	}
	const candidate = getUrlCandidate(trimmed)
	if (
		candidate === trimmed &&
		URL_SCHEME_PREFIX_REGEX.test(trimmed) &&
		!URL_SCHEME_REGEX.test(trimmed)
	) {
		throw new NutstoreBaseUrlValidationError('invalidFormat')
	}
	let url: URL
	try {
		url = new URL(candidate)
	} catch {
		throw new NutstoreBaseUrlValidationError('invalidFormat')
	}
	if (!['http:', 'https:'].includes(url.protocol)) {
		throw new NutstoreBaseUrlValidationError('unsupportedProtocol')
	}
	url.search = ''
	url.hash = ''
	return trimTrailingSlash(url.toString())
}

export function isValidNutstoreBaseUrl(value: string) {
	try {
		normalizeNutstoreBaseUrl(value)
		return true
	} catch {
		return false
	}
}

function getCustomNutstoreBaseUrl(settings: NutstoreSettings) {
	if (settings.loginMode !== 'manual') {
		return null
	}
	if (!settings.nutstoreEnterpriseBaseUrl?.trim()) {
		return null
	}
	try {
		return normalizeNutstoreBaseUrl(settings.nutstoreEnterpriseBaseUrl)
	} catch {
		return null
	}
}

export function getNutstoreDavEndpoint(settings: NutstoreSettings) {
	const customBaseUrl = getCustomNutstoreBaseUrl(settings)
	return customBaseUrl ? `${customBaseUrl}/dav` : DEFAULT_NS_DAV_ENDPOINT
}

export function getNutstoreNsdavEndpoint(settings: NutstoreSettings) {
	const customBaseUrl = getCustomNutstoreBaseUrl(settings)
	return customBaseUrl ? `${customBaseUrl}/nsdav` : DEFAULT_NS_NSDAV_ENDPOINT
}
