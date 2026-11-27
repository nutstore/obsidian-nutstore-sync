// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	APP_ERROR_DEDUP_WINDOW_MS,
	APP_RUNTIME_SCRIPT_URL,
	AppErrorDeduplicator,
	AppSourceMapper,
	computeErrorFingerprint,
	parseStackFrames,
	type AppLogEvent,
} from './diagnostics'
import { assembleAppContent, type AppSourceReader } from './source'

function makeReader(files: Record<string, string>): AppSourceReader {
	return {
		readText: async (path) => {
			const value = files[path]
			if (value === undefined) throw new Error(`missing: ${path}`)
			return value
		},
		readBinary: async () => new ArrayBuffer(0),
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('App diagnostics source mapping and deduplication', () => {
	it('maps V8 and WebKit/JSC stack frames across inline and external scripts with surrounding code context', async () => {
		const html = [
			'<!doctype html>',
			'<html>',
			'<body>',
			'<!-- <script>ignored comment</script> -->',
			'<script>',
			'const title = "中性标题 Neutral 🌿";',
			'function inlineStep() {',
			'  return externalStep();',
			'}',
			'</script>',
			'<script src="js/核心 core 🌿.js"></script>',
			'</body>',
			'</html>',
		].join('\n')
		const externalJs = [
			'function helper() {',
			'  const label = "执行阶段 Stage 🧭";',
			'  throw new TypeError("失败 Failure 🌿");',
			'}',
			'function externalStep() {',
			'  return helper();',
			'}',
		].join('\n')

		const content = await assembleAppContent({
			html,
			reader: makeReader({ 'js/核心 core 🌿.js': externalJs }),
		})
		expect(content.scriptMap).toEqual([
			{
				path: 'index.html',
				startLine: 1,
				lineCount: 6,
				sourceStartLine: 5,
				inlineIndex: 1,
			},
			{
				path: 'js/核心 core 🌿.js',
				startLine: 8,
				lineCount: 7,
				sourceStartLine: 1,
			},
		])

		const mapper = new AppSourceMapper(content)
		// Wrapper adds 1 line (`(async () => {\n`):
		// - `js/核心 core 🌿.js` line 3 => content line 10 => nutstore-app.js line 11
		// - `index.html` inline line 4 (`return externalStep();`) => html line 8 => content line 4 => nutstore-app.js line 5
		const v8Stack = [
			'TypeError: 失败 Failure 🌿',
			`    at helper (${APP_RUNTIME_SCRIPT_URL}:11:9)`,
			`    at externalStep (${APP_RUNTIME_SCRIPT_URL}:14:10)`,
			`    at inlineStep (${APP_RUNTIME_SCRIPT_URL}:5:10)`,
		].join('\n')

		const enrichedV8 = mapper.enrichEvent(
			{
				level: 'error',
				source: 'startup',
				name: 'TypeError',
				message: '失败 Failure 🌿',
				stack: v8Stack,
				causes: [
					{
						name: 'RangeError',
						code: 'ERR_RANGE',
						message: '根因 Root cause 🌱',
						stack: `RangeError: 根因 Root cause 🌱\n    at helper (${APP_RUNTIME_SCRIPT_URL}:11:9)`,
					},
				],
			},
			{ sessionId: 'session-1', phase: 'live', webview: 'Chromium 120.0' },
		)

		expect(enrichedV8.filename).toBe('js/核心 core 🌿.js')
		expect(enrichedV8.line).toBe(3)
		expect(enrichedV8.column).toBe(9)
		expect(enrichedV8.sessionId).toBe('session-1')
		expect(enrichedV8.phase).toBe('live')
		expect(enrichedV8.sourceHash).toBe(mapper.sourceHash)
		expect(enrichedV8.context?.webview).toBe('Chromium 120.0')
		expect(enrichedV8.fingerprint).toBeTruthy()
		expect(enrichedV8.frames).toHaveLength(3)
		expect(enrichedV8.frames![0]).toMatchObject({
			function: 'helper',
			filename: 'js/核心 core 🌿.js',
			line: 3,
			column: 9,
			inApp: true,
			context: {
				startLine: 1,
				highlightLine: 3,
				lines: [
					'function helper() {',
					'  const label = "执行阶段 Stage 🧭";',
					'  throw new TypeError("失败 Failure 🌿");',
					'}',
					'function externalStep() {',
				],
			},
		})
		expect(enrichedV8.frames![2]).toMatchObject({
			function: 'inlineStep',
			filename: 'index.html',
			line: 8,
			column: 10,
			inApp: true,
		})
		expect(enrichedV8.causes?.[0]?.frames?.[0]).toMatchObject({
			filename: 'js/核心 core 🌿.js',
			line: 3,
		})

		// Verify JavaScriptCore / WebKit stack format (`fn@file:line:col`) maps identically.
		const jscStack = [
			`helper@${APP_RUNTIME_SCRIPT_URL}:11:9`,
			`inlineStep@${APP_RUNTIME_SCRIPT_URL}:5:10`,
		].join('\n')
		const jscFrames = mapper.parseAndMapStack(jscStack)
		expect(jscFrames).toHaveLength(2)
		expect(jscFrames[0]).toMatchObject({
			function: 'helper',
			filename: 'js/核心 core 🌿.js',
			line: 3,
			column: 9,
		})
		expect(jscFrames[1]).toMatchObject({
			function: 'inlineStep',
			filename: 'index.html',
			line: 8,
			column: 10,
		})
	})

	it('maps CSP violation source locations back to authored files', async () => {
		const content = await assembleAppContent({
			html: '<script src="net.js"></script>',
			reader: makeReader({
				'net.js': 'const a = 1;\nfetch("https://example.test/data");',
			}),
		})
		const mapper = new AppSourceMapper(content)
		const enriched = mapper.enrichEvent({
			level: 'error',
			source: 'csp',
			name: 'SecurityPolicyViolation',
			message: 'CSP violation (connect-src): blocked https://example.test/data',
			filename: APP_RUNTIME_SCRIPT_URL,
			line: 3,
			column: 1,
			context: {
				csp: {
					effectiveDirective: 'connect-src',
					blockedURI: 'https://example.test/data',
					sourceFile: APP_RUNTIME_SCRIPT_URL,
					line: 3,
					column: 1,
				},
			},
		})
		expect(enriched.filename).toBe('net.js')
		expect(enriched.line).toBe(2)
		expect(enriched.context?.csp?.sourceFile).toBe('net.js')
		expect(enriched.context?.csp?.line).toBe(2)
	})

	it('parses frames whose filenames contain spaces, colons, CJK and Emoji', () => {
		const frames = parseStackFrames(
			'    at 中性函数 (file:///目录/脚本 Script 🌿.js:42:13)\n@模块 Module 🧭.js:7:2',
		)
		expect(frames).toHaveLength(2)
		expect(frames[0]).toMatchObject({
			function: '中性函数',
			filename: 'file:///目录/脚本 Script 🌿.js',
			line: 42,
			column: 13,
		})
		expect(frames[1]).toMatchObject({
			filename: '模块 Module 🧭.js',
			line: 7,
			column: 2,
		})
	})

	it('folds burst identical errors with exact occurrence counts while never capping distinct errors', () => {
		vi.useFakeTimers()
		const summaries: AppLogEvent[] = []
		const dedup = new AppErrorDeduplicator(
			(summary) => summaries.push(summary),
			window,
			APP_ERROR_DEDUP_WINDOW_MS,
		)

		const loopError: AppLogEvent = {
			level: 'error',
			source: 'uncaught',
			name: 'TypeError',
			message: '渲染帧异常 Render frame error 🌿',
			filename: 'loop.js',
			line: 10,
		}
		loopError.fingerprint = computeErrorFingerprint(loopError)

		expect(dedup.record(loopError)).toBe(true)
		for (let i = 0; i < 49; i++) {
			expect(dedup.record(loopError)).toBe(false)
		}

		// Distinct errors are never capped or dropped (well past the legacy 10-error limit).
		let emittedDistinct = 0
		for (let i = 0; i < 25; i++) {
			const distinct: AppLogEvent = {
				level: 'error',
				source: 'uncaught',
				name: 'Error',
				message: `独立错误 Distinct error #${i} 🌿`,
				filename: 'app.js',
				line: i + 1,
			}
			distinct.fingerprint = computeErrorFingerprint(distinct)
			if (dedup.record(distinct)) emittedDistinct++
		}
		expect(emittedDistinct).toBe(25)

		vi.advanceTimersByTime(APP_ERROR_DEDUP_WINDOW_MS)
		expect(summaries).toHaveLength(1)
		expect(summaries[0]).toMatchObject({
			message: '渲染帧异常 Render frame error 🌿',
			fingerprint: loopError.fingerprint,
			occurrences: 50,
		})

		// A flush before window expiry also emits folded counts cleanly.
		expect(dedup.record(loopError)).toBe(true)
		expect(dedup.record(loopError)).toBe(false)
		expect(dedup.record(loopError)).toBe(false)
		dedup.flush()
		expect(summaries).toHaveLength(2)
		expect(summaries[1]?.occurrences).toBe(3)
	})
})
