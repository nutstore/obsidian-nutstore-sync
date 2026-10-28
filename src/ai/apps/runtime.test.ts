// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { InMemoryFs } from 'just-bash/browser'
import { createAppFSDispatcher } from './capabilities/fs'
import { AppRuntime, runtimeDocument } from './runtime'
import { validateAppIcon, appIconContent } from './icon'
import type { AppContent } from './source'
import type { AppKV } from './capabilities/kv'
import { AppAIBridge } from './ai/bridge'
import type { AppAIHost } from './ai/contract'

const content: AppContent = {
	html: '<button id="add">增加 Add 🌿</button>',
	css: 'button { min-height: 44px; }',
	javascript: '',
}

function createHost(kv: AppKV = { '进度 Progress 🌿': 1 }) {
	return {
		readKV: vi.fn(async () => kv),
		transact: vi.fn(async () => {}),
		log: vi.fn(),
		error: vi.fn(),
	}
}

function installDocumentHelpers() {
	Object.defineProperty(document, 'win', {
		configurable: true,
		value: {
			createEl: (tag: string) => document.createElement(tag),
		},
	})
}
function timeout(ms: number) {
	return new Promise((resolve) => window.setTimeout(resolve, ms))
}

beforeEach(() => {
	installDocumentHelpers()
	document.body.replaceChildren()
})

afterEach(() => {
	document.body.replaceChildren()
	delete (document as { win?: unknown }).win
	vi.restoreAllMocks()
})

describe('App runtime and trusted SVG boundary', () => {
	it('executes serialized AI callbacks and streams across the sandbox bridge', async () => {
		const messages: Record<string, unknown>[] = []
		let receive!: (data: Record<string, unknown>) => void
		const host: AppAIHost = async (request, execution) => {
			expect(request.call).toEqual({ prompt: '检查 Inspect 🌿' })
			execution.emit({ type: 'text-delta', id: 'text', text: '完成 Done 🌿' })
			const output = await execution.execute(
				'inspect',
				{ text: '条目 Item 🌿' },
				'call',
			)
			return {
				text: JSON.stringify(output),
				responseMessages: [],
				finishReason: 'stop',
				usage: {
					inputTokens: 1,
					outputTokens: 1,
					totalTokens: 2,
					inputTokenDetails: {
						noCacheTokens: 1,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
					outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
				},
			}
		}
		const bridge = new AppAIBridge(host, (event) =>
			receive({ ...structuredClone(event), channel: 'neutral' }),
		)
		const dom = new JSDOM(
			runtimeDocument(
				{
					...content,
					javascript: `
			// AI runs with the iframe's globals, independently of host polyfills.
			Object.fromEntries = undefined;
			Object.hasOwn = undefined;
			const agent = app.ai.createAgent({ tools: {
				inspect: {
					description: '检查 Inspect 🌿', inputSchema: { type: 'object' },
					async execute(input, context) {
						return { text: input.text, cancelled: context.abortSignal.aborted };
					}
				}
			} });
			document.querySelector('#add').addEventListener('click', async () => {
				const result = await agent.stream({ prompt: '检查 Inspect 🌿' });
				let text = '';
				for await (const chunk of result.textStream) text += chunk;
				await app.kv.set('流 Stream 🌿', text);
				await app.kv.set('结果 Result 🌿', await result.text);
			});
		`,
				},
				'neutral',
			),
			{
				runScripts: 'dangerously',
				beforeParse(win) {
					receive = (data) =>
						win.dispatchEvent(
							new win.MessageEvent('message', {
								source: win as unknown as Window,
								data,
							}),
						)
					win.postMessage = (message: Record<string, unknown>) => {
						messages.push(message)
						if (typeof message.id !== 'number') return
						const method = String(message.method)
						const promise = method.startsWith('ai.')
							? bridge.dispatch(
									method.slice(3),
									structuredClone(message.args) as unknown[],
								)
							: Promise.resolve(null)
						void promise.then(
							(value) => receive({ channel: 'neutral', id: message.id, value }),
							() =>
								receive({
									channel: 'neutral',
									id: message.id,
									error: 'AI_FAILED',
									code: 'AI_FAILED',
								}),
						)
					}
				},
			},
		)
		await timeout(20)
		;(dom.window.document.querySelector('#add') as HTMLButtonElement).click()
		await vi.waitFor(() =>
			expect(
				messages.filter((message) => message.method === 'kv.transact'),
			).toHaveLength(2),
		)
		expect(
			messages
				.filter((message) => message.method === 'kv.transact')
				.map((message) => message.args),
		).toEqual([
			[[{ key: '流 Stream 🌿', value: '完成 Done 🌿' }]],
			[
				[
					{
						key: '结果 Result 🌿',
						value: '{"text":"条目 Item 🌿","cancelled":false}',
					},
				],
			],
		])
		bridge.close()
		dom.window.close()
	})

	it('authenticates AI requests and aborts host inference when the iframe is destroyed', async () => {
		let signal: AbortSignal | undefined
		const ai = vi.fn<AppAIHost>(async (_request, execution) => {
			signal = execution.signal
			return new Promise(() => {})
		})
		const runtime = new AppRuntime(document.body, content, {
			...createHost(),
			ai,
		})
		const channel = runtime.frame.srcdoc.match(/"channel":"([^"]+)"/)![1]
		const request = {
			channel,
			id: 1,
			method: 'ai.run',
			args: [
				{
					runId: 1,
					streaming: false,
					settings: {},
					call: { prompt: '问候 Greet 🌿' },
				},
			],
		}
		window.dispatchEvent(
			new MessageEvent('message', { source: window, data: request }),
		)
		window.dispatchEvent(
			new MessageEvent('message', {
				source: runtime.frame.contentWindow,
				data: { ...request, channel: 'other' },
			}),
		)
		expect(ai).not.toHaveBeenCalled()
		window.dispatchEvent(
			new MessageEvent('message', {
				source: runtime.frame.contentWindow,
				data: request,
			}),
		)
		expect(ai).toHaveBeenCalledOnce()
		expect(signal!.aborted).toBe(false)
		runtime.destroy()
		expect(signal!.aborted).toBe(true)
	})

	it('accepts inert icon geometry and rejects active SVG before entering host DOM', () => {
		expect(
			appIconContent(
				validateAppIcon(
					'<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="currentColor"/></svg>',
					document,
				),
			),
		).toContain('circle')
		for (const svg of [
			'<svg viewBox="0 0 100 100"><script>1</script></svg>',
			'<svg viewBox="0 0 100 100"><path onload="1"/></svg>',
			'<svg viewBox="0 0 100 100"><image href="https://example.test/image"/></svg>',
			'<svg viewBox="0 0 100 100"><path fill="url(#x)"/></svg>',
			'<svg viewBox="0 0 100 100"><foreignObject/></svg>',
		])
			expect(() => validateAppIcon(svg, document)).toThrow()
	})

	it('rejects runtime identities that could break the CSP nonce', () => {
		for (const channel of ['', 'has space', 'has-dash', '中性', 'app;'])
			expect(() => runtimeDocument(content, channel)).toThrow(
				'Invalid App runtime identity',
			)
	})

	it('emits a self-contained document with CSP, theme and escaped source', () => {
		const documentText = runtimeDocument(
			{
				...content,
				html: '</script><script>window.bad = 1</script>',
				javascript: 'const text = "</script>中性 Unicode 🌿"',
			},
			'neutral42',
			{
				colorScheme: 'dark',
				properties: { '--font-interface': '"中性 Interface 🌿", sans-serif' },
			},
		)
		expect(documentText).toContain("default-src 'none'")
		expect(documentText).toContain("script-src 'nonce-neutral42'")
		expect(documentText).toContain("base-uri 'none'")
		expect(documentText).toContain('--font-interface')
		expect(documentText).not.toContain('</script><script>window.bad')
		expect(documentText).toContain('\\u003c/script>')
	})

	it('authenticates the source and instance channel, validates data and revokes on close', async () => {
		const host = createHost()
		const runtime = new AppRuntime(
			document.body,
			content,
			host,
			'中性计数器 Neutral counter 🌿',
		)
		expect(runtime.frame.title).toBe('中性计数器 Neutral counter 🌿')
		const channel = runtime.frame.srcdoc.match(/"channel":"([^"]+)"/)![1]
		const send = (data: unknown, source = runtime.frame.contentWindow) =>
			window.dispatchEvent(new MessageEvent('message', { source, data }))

		send({
			channel: 'other',
			id: 1,
			method: 'kv.get',
			args: ['进度 Progress 🌿'],
		})
		send(
			{ channel, id: 1, method: 'kv.get', args: ['进度 Progress 🌿'] },
			window,
		)
		expect(host.readKV).not.toHaveBeenCalled()

		send({
			channel,
			id: 2,
			method: 'kv.transact',
			args: [[{ key: '进度 Progress 🌿', value: 2 }]],
		})
		await Promise.resolve()
		expect(host.transact).toHaveBeenCalledWith([
			{ key: '进度 Progress 🌿', value: 2 },
		])
		send({
			channel,
			id: 3,
			method: 'kv.transact',
			args: [[{ key: '__proto__', value: 2 }]],
		})
		await Promise.resolve()
		expect(host.transact).toHaveBeenCalledTimes(1)

		send({ channel, event: 'ready' })
		await runtime.ready
		const frame = runtime.frame.contentWindow
		runtime.destroy()
		send(
			{
				channel,
				id: 4,
				method: 'kv.transact',
				args: [[{ key: '进度 Progress 🌿', value: 3 }]],
			},
			frame,
		)
		expect(host.transact).toHaveBeenCalledTimes(1)
		expect(runtime.frame.getAttribute('sandbox')).toBe('allow-scripts')
	})

	it('bridges authenticated filesystem binary requests and stops dispatch after teardown', async () => {
		const fs = new InMemoryFs()
		const dispatch = vi.fn(
			createAppFSDispatcher(
				async () => fs,
				() => {},
			),
		)
		const runtime = new AppRuntime(document.body, content, {
			...createHost(),
			fs: dispatch,
		})
		const frame = runtime.frame.contentWindow!
		const post = vi.spyOn(frame, 'postMessage').mockImplementation(() => {})
		const channel = runtime.frame.srcdoc.match(/"channel":"([^"]+)"/)![1]
		const bytes = new Uint8Array([0, 128, 255])
		const request = (
			id: number,
			method: string,
			args: unknown[],
			source = frame,
		) =>
			window.dispatchEvent(
				new MessageEvent('message', {
					source,
					data: { channel, id, method, args },
				}),
			)
		request(1, 'fs.writeFile', ['/Asset 素材 🌿.bin', bytes], window)
		expect(dispatch).not.toHaveBeenCalled()
		request(2, 'fs.writeFile', ['/Asset 素材 🌿.bin', bytes])
		await vi.waitFor(() =>
			expect(post).toHaveBeenCalledWith(
				{ channel, id: 2, value: undefined },
				'*',
			),
		)
		request(3, 'fs.readFileBuffer', ['/Asset 素材 🌿.bin'])
		await vi.waitFor(() =>
			expect(post).toHaveBeenCalledWith({ channel, id: 3, value: bytes }, '*'),
		)
		runtime.destroy()
		request(4, 'fs.rm', ['/Asset 素材 🌿.bin'])
		expect(dispatch).toHaveBeenCalledTimes(2)
		expect(await fs.readFileBuffer('/Asset 素材 🌿.bin')).toEqual(bytes)
	})

	it('forwards only the latest theme without replacing the live frame', async () => {
		const runtime = new AppRuntime(document.body, content, createHost())
		const channel = runtime.frame.srcdoc.match(/"channel":"([^"]+)"/)![1]
		const frame = runtime.frame
		const postMessage = vi
			.spyOn(frame.contentWindow!, 'postMessage')
			.mockImplementation(() => {})
		runtime.updateTheme({
			colorScheme: 'dark',
			properties: { '--text-normal': '#123456' },
		})
		window.dispatchEvent(
			new MessageEvent('message', {
				source: frame.contentWindow,
				data: { channel, event: 'ready' },
			}),
		)
		await runtime.ready
		expect(postMessage).toHaveBeenCalledWith(
			{
				channel,
				event: 'theme',
				theme: {
					colorScheme: 'dark',
					properties: { '--text-normal': '#123456' },
				},
			},
			'*',
		)

		postMessage.mockClear()
		runtime.updateTheme({
			colorScheme: 'light',
			properties: { '--text-normal': '#654321' },
		})
		expect(postMessage).toHaveBeenCalledOnce()
		expect(runtime.frame).toBe(frame)
		runtime.destroy()
	})

	it('forwards structured logs and rejects startup with source and stack', async () => {
		const host = createHost()
		const runtime = new AppRuntime(document.body, content, host)
		const channel = runtime.frame.srcdoc.match(/"channel":"([^"]+)"/)![1]
		const send = (data: unknown) =>
			window.dispatchEvent(
				new MessageEvent('message', {
					source: runtime.frame.contentWindow,
					data,
				}),
			)
		send({
			channel,
			event: 'log',
			log: {
				level: 'warn',
				source: 'console',
				message: '提醒 Warning 中文 🌿',
			},
		})
		expect(host.log).toHaveBeenCalledWith({
			level: 'warn',
			source: 'console',
			message: '提醒 Warning 中文 🌿',
		})

		const rejected = runtime.ready.catch((error: unknown) => error)
		send({
			channel,
			event: 'error',
			failure: {
				name: 'TypeError',
				source: 'uncaught',
				message: '启动失败 Startup failed 🌿',
				stack:
					'TypeError: 启动失败 Startup failed 🌿\n    at nutstore-app.js:7:3',
				filename: 'nutstore-app.js',
				line: 7,
				column: 3,
			},
		})
		const error = await rejected
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toContain('at nutstore-app.js:7:3')
		expect(host.log).toHaveBeenLastCalledWith({
			level: 'error',
			source: 'uncaught',
			message: '启动失败 Startup failed 🌿',
			stack:
				'TypeError: 启动失败 Startup failed 🌿\n    at nutstore-app.js:7:3',
			filename: 'nutstore-app.js',
			line: 7,
			column: 3,
		})
		expect(host.error).toHaveBeenCalledWith(
			expect.stringContaining('nutstore-app.js:7:3'),
		)
		runtime.destroy()
	})

	it('rejects a pending mount when the runtime is closed', async () => {
		const runtime = new AppRuntime(document.body, content, createHost())
		const rejection = runtime.ready.catch((error: unknown) => error)
		runtime.destroy()
		expect((await rejection) as Error).toMatchObject({ message: 'App closed' })
	})

	it('initializes without host DOM helpers or modern Object methods and executes Unicode source safely', async () => {
		const messages: Record<string, unknown>[] = []
		const runtimeContent: AppContent = {
			html: '<button id="add" onclick="bad()">增加 Add 🌿</button><script>window.bad = 1</script>',
			css: '',
			javascript:
				'const marker = "</script>中文 Unicode 🌿"; document.querySelector("#add").addEventListener("click", () => app.kv.set("进度 Progress 🌿", marker));',
		}
		const dom = new JSDOM(
			runtimeDocument(runtimeContent, 'neutral', {
				colorScheme: 'dark',
				properties: { '--text-normal': '#123456' },
			}),
			{
				runScripts: 'dangerously',
				beforeParse(win) {
					Reflect.deleteProperty(win.Object, 'fromEntries')
					Reflect.deleteProperty(win.Object, 'entries')
					Reflect.deleteProperty(win.Object, 'hasOwn')
					win.postMessage = (message: Record<string, unknown>) => {
						messages.push(message)
						if (message.id)
							win.dispatchEvent(
								new win.MessageEvent('message', {
									source: win as unknown as Window,
									data: { channel: 'neutral', id: message.id, value: null },
								}),
							)
					}
				},
			},
		)
		await timeout(20)
		expect(
			dom.window.document.documentElement.style.getPropertyValue(
				'--text-normal',
			),
		).toBe('#123456')
		expect(messages.some((message) => message.event === 'ready')).toBe(true)
		expect(Object.keys((dom.window as unknown as { app: object }).app)).toEqual(
			['fs', 'kv', 'ai'],
		)
		expect((dom.window as unknown as { bad?: number }).bad).toBeUndefined()
		expect(
			dom.window.document.querySelector('#add')!.hasAttribute('onclick'),
		).toBe(false)
		;(dom.window.document.querySelector('#add') as HTMLButtonElement).click()
		expect(
			messages.find((message) => message.method === 'kv.transact')?.args,
		).toEqual([
			[{ key: '进度 Progress 🌿', value: '</script>中文 Unicode 🌿' }],
		])
		dom.window.close()
	})

	it('allows data image, audio, video and font resources while stripping active URLs', async () => {
		const runtimeContent: AppContent = {
			html: [
				'<img id="local" src="data:image/svg+xml;base64,PHN2Zy8+" onerror="bad()">',
				'<audio id="audio" src="data:audio/mpeg;base64,AAAA"></audio>',
				'<video id="video" src="data:video/mp4;base64,AAAA" poster="data:image/png;base64,AAAA"></video>',
				'<img id="remote" src="https://example.test/neutral.png">',
				'<a id="fragment" href="#section">章节 Section 🌿</a>',
				'<a id="remote-link" href="https://example.test/">远程 Remote 🌿</a>',
				'<a id="data-link" href="data:font/woff2;base64,AAAA">字体 Font 🌿</a>',
				'<iframe id="frame" src="data:text/html,<p>bad</p>"></iframe>',
				'<object id="object" data="data:image/png;base64,AAAA"></object>',
				'<embed id="embed" src="https://example.test/app">',
				'<style>body { color: red; }</style>',
				'<base href="/">',
				'<script>window.userScript = 1</script>',
			].join(''),
			css: 'p { color: green; }',
			javascript: '',
		}
		const dom = new JSDOM(runtimeDocument(runtimeContent, 'neutral'), {
			runScripts: 'dangerously',
		})
		await timeout(10)
		const body = dom.window.document.body
		expect(body.querySelector('#local')?.getAttribute('src')).toBe(
			'data:image/svg+xml;base64,PHN2Zy8+',
		)
		expect(body.querySelector('#local')?.hasAttribute('onerror')).toBe(false)
		expect(body.querySelector('#audio')?.getAttribute('src')).toBe(
			'data:audio/mpeg;base64,AAAA',
		)
		expect(body.querySelector('#video')?.getAttribute('src')).toBe(
			'data:video/mp4;base64,AAAA',
		)
		expect(body.querySelector('#video')?.getAttribute('poster')).toBe(
			'data:image/png;base64,AAAA',
		)
		expect(body.querySelector('#fragment')?.getAttribute('href')).toBe(
			'#section',
		)
		expect(body.querySelector('#data-link')?.getAttribute('href')).toBe(
			'data:font/woff2;base64,AAAA',
		)
		expect(body.querySelector('#remote')?.hasAttribute('src')).toBe(false)
		expect(body.querySelector('#remote-link')?.hasAttribute('href')).toBe(false)
		for (const selector of ['#frame', '#object', '#embed', 'base', 'style'])
			expect(body.querySelector(selector)).toBeNull()
		expect(
			(dom.window as unknown as { userScript?: number }).userScript,
		).toBeUndefined()
		// The host still injects its base stylesheet and the App stylesheet.
		const styles = [...dom.window.document.head.querySelectorAll('style')]
		expect(styles).toHaveLength(2)
		expect(styles.map((style) => style.textContent).join('\n')).toContain(
			'p { color: green; }',
		)
		expect(body.querySelector('script')?.textContent).toContain('__appStarted')
		dom.window.close()
	})

	it('applies the markup policy inside nested templates before they are activated', async () => {
		const dom = new JSDOM(
			runtimeDocument(
				{
					html: `<template id="outer"><template id="inner">
				<button id="nested" onclick="window.bad = 1">中性 Neutral 🌿</button>
				<script>window.bad = 1</script><iframe srcdoc="bad"></iframe>
				<video poster="https://example.test/neutral.png"></video>
				<img src="data:image/png;base64,AAAA" onerror="window.bad = 1">
			</template></template>`,
					css: '',
					javascript: `const outer = document.querySelector('#outer');
				document.body.append(outer.content.cloneNode(true));
				const inner = document.querySelector('#inner');
				document.body.append(inner.content.cloneNode(true));`,
				},
				'neutral',
			),
			{ runScripts: 'dangerously' },
		)
		try {
			await timeout(10)
			const body = dom.window.document.body
			expect(body.querySelector('#nested')?.textContent).toBe('中性 Neutral 🌿')
			expect(body.querySelector('#nested')?.hasAttribute('onclick')).toBe(false)
			expect(body.querySelector('iframe')).toBeNull()
			expect(body.querySelector('video')?.hasAttribute('poster')).toBe(false)
			expect(body.querySelector('img')?.getAttribute('src')).toBe(
				'data:image/png;base64,AAAA',
			)
			expect(body.querySelector('img')?.hasAttribute('onerror')).toBe(false)
			expect(body.querySelectorAll('script')).toHaveLength(1)
			expect((dom.window as unknown as { bad?: number }).bad).toBeUndefined()
		} finally {
			dom.window.close()
		}
	})

	it('captures console entries and unhandled startup failures in the sandbox', async () => {
		const messages: Record<string, unknown>[] = []
		const runtimeContent: AppContent = {
			...content,
			javascript:
				'console.warn("提醒 Warning 中文 🌿", {阶段: "初始化 Stage"}); throw new TypeError("启动失败 Startup failed 🌿");',
		}
		const dom = new JSDOM(runtimeDocument(runtimeContent, 'neutral'), {
			runScripts: 'dangerously',
			beforeParse(win) {
				win.postMessage = (message: Record<string, unknown>) => {
					messages.push(message)
				}
			},
		})
		await timeout(30)
		const log = messages.find(
			(message) =>
				message.event === 'log' &&
				(message.log as { level?: string } | undefined)?.level === 'warn',
		)?.log as { message?: string; source?: string } | undefined
		expect(log?.source).toBe('console')
		expect(log?.message).toContain('提醒 Warning 中文 🌿')
		expect(log?.message).toContain('初始化 Stage')
		const failure = messages.find((message) => message.event === 'error')
			?.failure as
			| { message?: string; name?: string; source?: string; stack?: string }
			| undefined
		expect(failure).toMatchObject({
			name: 'TypeError',
			source: 'startup',
			message: '启动失败 Startup failed 🌿',
		})
		expect(failure?.stack).toContain('启动失败 Startup failed 🌿')
		dom.window.close()
	})

	it('applies and refreshes Obsidian theme tokens without replacing the App DOM', async () => {
		const theme = {
			colorScheme: 'dark' as const,
			properties: {
				'--font-interface': '"中性 Interface 🌿", sans-serif',
				'--background-modifier-border': '#123456',
			},
		}
		const dom = new JSDOM(runtimeDocument(content, 'neutral', theme), {
			runScripts: 'dangerously',
		})
		await timeout(20)
		const root = dom.window.document.documentElement
		const body = dom.window.document.body
		expect(root.style.getPropertyValue('--font-interface')).toBe(
			'"中性 Interface 🌿", sans-serif',
		)
		expect(root.style.getPropertyValue('--background-modifier-border')).toBe(
			'#123456',
		)
		expect(root.style.getPropertyValue('color-scheme')).toBe('dark')

		dom.window.dispatchEvent(
			new dom.window.MessageEvent('message', {
				source: dom.window as unknown as Window,
				data: {
					channel: 'neutral',
					event: 'theme',
					theme: {
						colorScheme: 'light',
						properties: {
							'--text-normal': '#654321',
						},
					},
				},
			}),
		)
		expect(root.style.getPropertyValue('--text-normal')).toBe('#654321')
		expect(root.style.getPropertyValue('--font-interface')).toBe('')
		expect(root.style.getPropertyValue('color-scheme')).toBe('light')
		expect(dom.window.document.body).toBe(body)
		dom.window.close()
	})

	it('defaults the frame title and passes content through unchanged', () => {
		const runtime = new AppRuntime(document.body, content, createHost())
		expect(runtime.frame.title).toBe('App')
		expect(runtime.content).toBe(content)
		const channel = runtime.frame.srcdoc.match(/"channel":"([^"]+)"/)![1]
		expect(channel).toMatch(/^[a-zA-Z0-9]+$/)
		runtime.destroy()
	})

	it('reads the host theme when mounting', () => {
		document.body.className = 'theme-dark'
		document.body.style.setProperty('--text-normal', '#abcdef')
		const runtime = new AppRuntime(document.body, content, createHost())
		expect(runtime.frame.srcdoc).toContain('"colorScheme":"dark"')
		expect(runtime.frame.srcdoc).toContain('--text-normal')
		runtime.destroy()
		document.body.className = ''
		document.body.style.removeProperty('--text-normal')
	})
})
