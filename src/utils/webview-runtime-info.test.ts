import { describe, expect, it } from 'vitest'
import { getWebviewRuntimeInfo } from './webview-runtime-info'

describe('WebView runtime diagnostics', () => {
	it.each([
		{
			name: 'desktop Chromium with Electron',
			ua: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0.6723.191 Electron/33.3.2 Safari/537.36',
			runtime: 'Chromium 130.0.6723.191 / Electron 33.3.2',
		},
		{
			name: 'Android WebView with a reduced version',
			ua: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
			runtime: 'Chromium 130.0.0.0',
		},
		{
			name: 'iOS WebKit without an exact build version',
			ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
			runtime: 'WebKit',
		},
		{
			name: 'iOS browser branding still uses WebKit',
			ua: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
			runtime: 'WebKit',
		},
		{
			name: 'Firefox runtime',
			ua: 'Mozilla/5.0 Gecko/20100101 Firefox/130.0',
			runtime: 'Firefox 130.0',
		},
		{
			name: 'unknown runtime with multilingual host branding',
			ua: 'Notes 笔记 📝/1.0',
			runtime: null,
		},
		{ name: 'empty UA', ua: '', runtime: null },
	])('$name preserves the original UA', ({ ua, runtime }) => {
		expect(getWebviewRuntimeInfo(ua)).toEqual({ userAgent: ua, runtime })
	})
})
