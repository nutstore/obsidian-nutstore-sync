import {
	Platform,
	requestUrl as req,
	RequestUrlParam,
	RequestUrlResponse,
} from 'obsidian'
import { PLUGIN_VERSION } from '~/consts'
import logger from './logger'

const getOS = () => {
	if (Platform.isWin) return 'Windows'
	if (Platform.isMacOS) return 'macOS'
	if (Platform.isLinux) return 'Linux'
	if (Platform.isAndroidApp) return 'Android'
	if (Platform.isIosApp) return 'iOS'
	return 'Unknown'
}

const getDevice = () => {
	if (Platform.isTablet) return 'Tablet'
	if (Platform.isPhone) return 'Phone'
	if (Platform.isDesktopApp) return 'Desktop'
	if (Platform.isMobileApp) return 'Mobile'
	return 'Unknown'
}

const MOCK_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
const NS_SYNC_USER_AGENT = `Obsidian (${getOS()}; ${getDevice()}; ObsidianNutstoreSync/${PLUGIN_VERSION})`

function shouldAttachUserAgent(url: string) {
	try {
		const hostname = new URL(url).hostname
		return hostname === 'jianguoyun.com' || hostname.endsWith('.jianguoyun.com')
	} catch {
		return false
	}
}

class RequestUrlError extends Error {
	constructor(public res: RequestUrlResponse) {
		super(`${res.status}: ${res.text}`)
	}
}

export default async function requestUrl(p: RequestUrlParam | string) {
	const url = typeof p === 'string' ? p : p.url
	const originalHeaders = typeof p === 'string' ? {} : p.headers || {}
	const headers = shouldAttachUserAgent(url)
		? {
				...originalHeaders,
				'User-Agent': MOCK_USER_AGENT,
			}
		: {
				...originalHeaders,
				'User-Agent': NS_SYNC_USER_AGENT,
			}

	const params: RequestUrlParam =
		typeof p === 'string'
			? {
					url,
					throw: false,
					headers,
				}
			: {
					...p,
					throw: false,
					headers,
				}

	const res = await req(params)

	if (res.status >= 400) {
		logger.error(res)
		if (typeof p === 'string' || p.throw !== false) {
			throw new RequestUrlError(res)
		}
	}

	return res
}
