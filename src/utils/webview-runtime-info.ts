export interface WebviewRuntimeInfo {
	userAgent: string
	runtime: string | null
}

/** UA-reported versions are diagnostic hints, not capability checks or exact engine builds. */
export function getWebviewRuntimeInfo(
	// eslint-disable-next-line obsidianmd/platform -- Collect browser diagnostics; OS detection uses Platform.
	userAgent = navigator.userAgent,
): WebviewRuntimeInfo {
	const chromium = /\b(?:Chrome|Chromium)\/([\d.]+)/.exec(userAgent)?.[1]
	const electron = /\bElectron\/([\d.]+)/.exec(userAgent)?.[1]
	const firefox = /\bFirefox\/([\d.]+)/.exec(userAgent)?.[1]
	let runtime: string | null = null
	if (chromium) {
		runtime = `Chromium ${chromium}`
	} else if (firefox) {
		runtime = `Firefox ${firefox}`
	} else if (/\bAppleWebKit\//.test(userAgent)) {
		// AppleWebKit's compatibility token does not identify the installed WebKit build.
		runtime = 'WebKit'
	}
	if (electron) {
		runtime = [runtime, `Electron ${electron}`].filter(Boolean).join(' / ')
	}
	return { userAgent, runtime }
}
