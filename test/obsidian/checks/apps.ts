import type { App } from 'obsidian'
import type { AppAIHost } from '~/ai/apps/ai/contract'
import { assert } from './assert'
import {
	APP_DATA_FILE,
	APP_ENTRY_FILE,
	APP_MANIFEST_FILE,
	APP_STATE_FILE,
	APP_VIEW_TYPE,
	appDirectoryPath,
	getProductionPlugin,
} from './constants'
import { assertViewAboveMobileNavigation } from './mobile-navigation'

const APP_ID = 'org.example.counter'
const APP_TITLE = '中性计数器 Neutral counter 🌿'
const SVG_ASSET =
	'<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
const KP_COUNT = '次数 Count 🌿'
const KP_STARTUP = '启动 App startup 🌿'
const KP_FAILURE = '启动失败 Startup failed 🌿'

const SCRIPT = [
	`const key = "${KP_COUNT}";`,
	'let count = (await app.kv.get(key)) ?? 0;',
	'const output = document.querySelector("#count");',
	'output.textContent = String(count);',
	'document.querySelector("#add").addEventListener("click", async () => {',
	'  count += 1;',
	'  await app.kv.set(key, count);',
	'  output.textContent = String(count);',
	'});',
	'window.addEventListener("message", (event) => {',
	'  if (event.data?.test === "add") document.querySelector("#add").click();',
	'});',
	'let isolated = false;',
	'try { void parent.document.body } catch { isolated = true }',
	'if (!isolated) throw new Error("Isolation failed");',
	`console.info("${KP_STARTUP}");`,
].join('\n')

const FAILING_SCRIPT = [
	`await app.kv.set("临时 Temporary 🌿", true);`,
	`throw new Error("${KP_FAILURE}");`,
].join('\n')

async function waitUntil(
	check: () => boolean | Promise<boolean>,
	label: string,
	detail?: () => string | Promise<string>,
) {
	const end = Date.now() + 15_000
	while (!(await check())) {
		if (Date.now() > end) {
			const extra = detail ? `\n${await detail()}` : ''
			throw new Error(`App check timed out: ${label}${extra}`)
		}
		await new Promise((resolve) => window.setTimeout(resolve, 50))
	}
}

async function rejection(promise: Promise<unknown>) {
	try {
		await promise
	} catch (error) {
		return error as Error
	}
	throw new Error('Expected the App operation to reject')
}

function directoryPath() {
	return appDirectoryPath(APP_ID)
}

function appPath(name: string) {
	return `${directoryPath()}/${name}`
}

function htmlSource(extra = '') {
	return [
		'<link rel="stylesheet" href="styles.css">',
		`<h1 id="heading">${APP_TITLE}</h1>`,
		'<button id="add" type="button">增加 Add 🌿</button>',
		'<output id="count"></output>',
		'<img id="asset" src="media/neutral.svg" alt="中性图标 Neutral icon 🌿">',
		'<script src="app.js"></script>',
		extra,
	].join('')
}

/**
 * Exercise the loaded production plugin's App workspace lifecycle, opaque-origin
 * iframe sandbox, theme token injection, postMessage KV bridge, ribbon pin,
 * mobile navigation geometry, and hot reload against real Obsidian.
 */
export async function createsIndependentApps(app: App) {
	const plugin = getProductionPlugin(app)
	assert(plugin.ai.lifecycle.active, 'AI module is not active')
	const workspaces = plugin.ai.workspaces
	const store = plugin.ai.apps
	const adapter = app.vault.adapter
	const signal = plugin.ai.lifecycle.scope.signal

	try {
		if (await store.exists(APP_ID)) await workspaces.remove(APP_ID)
		const created = await workspaces.create(APP_ID, APP_TITLE)
		assert(
			created.manifest.title === APP_TITLE,
			'Created App lost its manifest title',
		)
		assert(created.manifest.iconSvg.length > 0, 'Created App has no icon')
		assert(created.state.pinned === false, 'A new App must not be pinned')
		assert(
			await adapter.exists(appPath(APP_MANIFEST_FILE)),
			'App manifest file was not written',
		)
		assert(
			await adapter.exists(appPath(APP_STATE_FILE)),
			'App state file was not written',
		)

		await adapter.write(appPath(APP_ENTRY_FILE), htmlSource())
		await adapter.write(
			appPath('styles.css'),
			[
				'button { min-height: 44px; }',
				'#asset { background-image: url("media/neutral.svg"); }',
			].join('\n'),
		)
		await adapter.write(appPath('app.js'), SCRIPT)
		await adapter.mkdir(`${directoryPath()}/media`)
		await adapter.writeBinary(
			appPath('media/neutral.svg'),
			new TextEncoder().encode(SVG_ASSET).buffer,
		)

		const listed = (await store.list()).find((item) => item.id === APP_ID)
		assert(listed?.app && !listed.error, 'Created App is not cleanly listable')
		assert(
			listed.app.manifest.title === APP_TITLE,
			'Listed App lost its manifest title',
		)

		const loaded = await workspaces.load(APP_ID)
		assert(
			loaded.content.html.includes('data:image/svg+xml;base64,') &&
				!loaded.content.html.includes('<link') &&
				loaded.content.css.includes('data:image/svg+xml;base64,') &&
				loaded.content.javascript.includes(KP_STARTUP),
			'Production App source assembly failed to inline local assets/scripts',
		)

		await workspaces.validate(APP_ID, signal)
		assert(
			!app.workspace.containerEl.querySelector('.ns-app-candidate'),
			'Validation sandbox leaked into the workspace',
		)
		assert(
			(await workspaces.logs.read(APP_ID)).includes(KP_STARTUP),
			'Validated App did not write startup diagnostics',
		)

		await store.transact(APP_ID, [{ key: KP_COUNT, value: 2 }])
		assert(
			(await store.readKV(APP_ID))[KP_COUNT] === 2,
			'App KV transaction did not round-trip',
		)
		const envelope = JSON.parse(await adapter.read(appPath(APP_DATA_FILE))) as {
			schemaVersion?: number
			kv?: Record<string, unknown>
		}
		assert(
			envelope.schemaVersion === 1 && envelope.kv?.[KP_COUNT] === 2,
			'App data envelope lost schema or KV value',
		)

		await workspaces.setPinned(APP_ID, true)
		await waitUntil(
			() =>
				Boolean(
					app.workspace.containerEl.querySelector(
						`[data-nutstore-app-id="${APP_ID}"]`,
					),
				),
			'pinned ribbon entry',
		)

		await adapter.write(
			appPath(APP_ENTRY_FILE),
			'<link rel="stylesheet" href="https://example.test/remote.css">',
		)
		const sourceFailure = await rejection(workspaces.load(APP_ID))
		assert(
			sourceFailure.message.includes('Remote URL is not supported'),
			'Source assembly did not reject a remote stylesheet',
		)
		await adapter.write(appPath(APP_ENTRY_FILE), htmlSource())

		await adapter.write(appPath('app.js'), FAILING_SCRIPT)
		const startupFailure = await rejection(workspaces.validate(APP_ID, signal))
		assert(
			startupFailure.message.includes(KP_FAILURE) &&
				startupFailure.message.includes('Runtime logs:'),
			'Invalid startup was accepted or missed diagnostics',
		)
		assert(
			(await store.readKV(APP_ID))['临时 Temporary 🌿'] === undefined,
			'Failed startup mutated App data',
		)
		await adapter.write(appPath('app.js'), SCRIPT)

		const opened = await plugin.ai.openApp(APP_ID)
		assert(opened?.manifest.title === APP_TITLE, 'Production openApp failed')
		await waitUntil(() => {
			const leaf = app.workspace
				.getLeavesOfType(APP_VIEW_TYPE)
				.find((item) => item.view.getState().appId === APP_ID)
			return Boolean(leaf?.view.containerEl.querySelector('iframe'))
		}, 'mounted App view iframe')

		const leaf = app.workspace
			.getLeavesOfType(APP_VIEW_TYPE)
			.find((item) => item.view.getState().appId === APP_ID)!
		await assertViewAboveMobileNavigation(leaf.view, '.ns-app-runtime')

		const frame = leaf.view.containerEl.querySelector('iframe')!
		assert(
			frame.getAttribute('sandbox') === 'allow-scripts',
			'App sandbox permissions are too broad',
		)
		assert(
			frame.srcdoc.includes('"colorScheme":"') &&
				frame.srcdoc.includes('--font-interface') &&
				frame.srcdoc.includes('--background-modifier-border'),
			'App iframe did not receive Obsidian color scheme and theme tokens',
		)

		await new Promise((resolve) => window.setTimeout(resolve, 300))
		frame.contentWindow!.postMessage({ test: 'add' }, '*')
		await waitUntil(
			async () => (await store.readKV(APP_ID))[KP_COUNT] === 3,
			'sandbox KV round-trip',
			async () => JSON.stringify(await store.readKV(APP_ID)),
		)

		// Hot reload through the loaded production store observer.
		await adapter.write(
			appPath(APP_ENTRY_FILE),
			htmlSource('<p id="reloaded">完成 Done 中文 🌿</p>'),
		)
		await workspaces.setPinned(APP_ID, true)
		await waitUntil(() => {
			const current = app.workspace
				.getLeavesOfType(APP_VIEW_TYPE)
				.find((item) => item.view.getState().appId === APP_ID)
			const currentFrame = current?.view.containerEl.querySelector('iframe')
			return Boolean(currentFrame?.srcdoc.includes('完成 Done 中文 🌿'))
		}, 'App view reload after source file change')

		leaf.detach()
		await workspaces.remove(APP_ID)
		assert(
			!(await adapter.exists(directoryPath())),
			'Deleting an App left its directory behind',
		)
	} finally {
		for (const leaf of app.workspace.getLeavesOfType(APP_VIEW_TYPE))
			leaf.detach()
		try {
			if (await store.exists(APP_ID)) await workspaces.remove(APP_ID)
		} catch {
			// Report the original check failure, not a cleanup failure.
		}
	}
}

/** Exercise the production bridge/serialized client in a real opaque-origin iframe, without paid inference. */
export async function runsAppAIThroughSandbox(app: App) {
	const plugin = getProductionPlugin(app)
	const id = 'org.example.ai'
	const workspaces = plugin.ai.workspaces
	const originalHost = workspaces.createRuntimeHost
	let calls = 0
	const ai: AppAIHost = async (_request, execution) => {
		calls++
		execution.emit({ type: 'text-delta', id: 'answer', text: '完成 Done 🌿' })
		const output = await execution.execute(
			'inspect',
			{ text: '条目 Item 🌿' },
			'inspect-call',
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
	workspaces.createRuntimeHost = function (appId, check) {
		const host = originalHost.call(this, appId, check)
		if (appId === id) host.ai = ai
		return host
	}
	try {
		await workspaces.create(id, '应用助手 App helper 🌿')
		await app.vault.adapter.write(
			`${appDirectoryPath(id)}/${APP_ENTRY_FILE}`,
			`<button id="ask">检查 Inspect 🌿</button><script>
			const assistant = app.ai.createAgent({ tools: { inspect: {
				description: '检查 Inspect 🌿', inputSchema: { type: 'object' },
				async execute(input) { return { inspected: input.text }; }
			} } });
			document.querySelector('#ask').addEventListener('click', async () => {
				try {
					const result = await assistant.stream({ prompt: '检查 Inspect 🌿' });
					let text = '';
					for await (const delta of result.textStream) text += delta;
					await app.kv.set('stream', text);
					await app.kv.set('result', await result.text);
				} catch (error) { await app.kv.set('failure', String(error)); }
			});
			window.addEventListener('message', (event) => {
				if (event.data?.test === 'ai') document.querySelector('#ask').click();
			});
		</script>`,
		)
		await workspaces.validate(id, plugin.ai.lifecycle.scope.signal)
		assert(Number(calls) === 0, 'Startup validation invoked AI')
		await plugin.ai.openApp(id)
		let frame: HTMLIFrameElement | null = null
		await waitUntil(() => {
			const leaf = app.workspace
				.getLeavesOfType(APP_VIEW_TYPE)
				.find((item) => item.view.getState().appId === id)
			frame = leaf?.view.containerEl.querySelector('iframe') ?? null
			return Boolean(frame)
		}, 'AI App iframe')
		await new Promise((resolve) => window.setTimeout(resolve, 300))
		frame!.contentWindow!.postMessage({ test: 'ai' }, '*')
		await waitUntil(
			async () => (await workspaces.store.readKV(id)).result !== undefined,
			'AI App tool and stream round-trip',
			async () => JSON.stringify(await workspaces.store.readKV(id)),
		)
		const data = await workspaces.store.readKV(id)
		assert(data.stream === '完成 Done 🌿', 'AI App lost streamed text')
		assert(
			data.result === '{"inspected":"条目 Item 🌿"}',
			'AI App lost its sandbox tool result',
		)
		assert(calls === 1, 'Stream consumers repeated inference')
	} finally {
		workspaces.createRuntimeHost = originalHost
		for (const leaf of app.workspace.getLeavesOfType(APP_VIEW_TYPE))
			if (leaf.view.getState().appId === id) leaf.detach()
		if (await workspaces.store.exists(id)) await workspaces.remove(id)
	}
}
