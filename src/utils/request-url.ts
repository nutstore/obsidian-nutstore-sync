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

const USER_AGENT = `Obsidian (${getOS()}; ${getDevice()}; ObsidianNutstoreSync/${PLUGIN_VERSION})`

class RequestUrlError extends Error {
	constructor(public res: RequestUrlResponse) {
		super(`${res.status}: ${res.text}`)
	}
}

export default async function requestUrl(p: RequestUrlParam | string) {
	const params: RequestUrlParam =
		typeof p === 'string'
			? {
					url: p,
					throw: false,
				}
			: {
					...p,
					throw: false,
					headers: {
						...(p.headers || {}),
					},
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
