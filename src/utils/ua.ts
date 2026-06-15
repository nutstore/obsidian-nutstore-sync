import { Platform } from 'obsidian'
import { PLUGIN_VERSION } from '~/consts'

function getOS() {
	if (Platform.isWin) return 'Windows'
	if (Platform.isMacOS) return 'macOS'
	if (Platform.isLinux) return 'Linux'
	if (Platform.isAndroidApp) return 'Android'
	if (Platform.isIosApp) return 'iOS'
	return 'Unknown'
}

function getDevice() {
	if (Platform.isTablet) return 'Tablet'
	if (Platform.isPhone) return 'Phone'
	if (Platform.isDesktopApp) return 'Desktop'
	if (Platform.isMobileApp) return 'Mobile'
	return 'Unknown'
}

export function isNutstoreHost(url: string) {
	try {
		return new URL(url).hostname.toLowerCase().includes('jianguoyun')
	} catch {
		return false
	}
}

export const NS_SYNC_USER_AGENT = `Obsidian (${getOS()}; ${getDevice()}; ObsidianNutstoreSync/${PLUGIN_VERSION})`
export const MOCK_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
