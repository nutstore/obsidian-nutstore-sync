import type { App } from 'obsidian'
import type NutstorePlugin from '~/index'
import { APP_VIEW_TYPE } from '~/views/app.view'
import {
	APP_DATA_FILE,
	APP_ENTRY_FILE,
	APP_MANIFEST_FILE,
	APP_STATE_FILE,
	appDirectoryPath,
} from '~/ai/apps/paths'
import { VaultFileSystemManager } from '~/ai/tools/vault-filesystem'
import { execVaultBash } from '~/ai/tools/bash/runtime'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { assert } from './assert'
import { assertViewAboveMobileNavigation } from './mobile-navigation'
import type { AppAIHost } from '~/ai/apps/ai/contract'

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

/** A denied mutation may surface as a thrown error or as a failed command result. */
async function expectBlocked(
	run: Promise<{ exitCode: number; stdout: string; stderr: string }>,
	message: string,
	expected = /read-only/,
) {
	let result: Awaited<typeof run>
	try {
		result = await run
	} catch (error) {
		assert(
			expected.test(error instanceof Error ? error.message : String(error)),
			message,
		)
		return
	}
	assert(
		result.exitCode !== 0 && expected.test(`${result.stdout}${result.stderr}`),
		`${message}: exit=${result.exitCode}, stderr=${result.stderr}`,
	)
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
function pluginFor(app: App) {
	return (
		app as unknown as { plugins: { plugins: Record<string, NutstorePlugin> } }
	).plugins.plugins['nutstore-sync']
}

/**
 * Apps are plain vault directories: create host state, author real files, then
 * verify listing, assembly, sandbox validation, KV/log round-trips, hot reload,
 * the `app open` command and deletion against a real Obsidian Webview.
 */
export async function createsIndependentApps(app: App) {
	const plugin = pluginFor(app)
	assert(plugin, 'Production plugin is not loaded')
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
		assert(
			!(await adapter.exists(appPath('app.json'))),
			'App directory must not contain a revision file',
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
		await mkdirsVault(app.vault, `${directoryPath()}/media`)
		await adapter.writeBinary(
			appPath('media/neutral.svg'),
			new TextEncoder().encode(SVG_ASSET).buffer,
		)

		const listed = (await store.list()).find((item) => item.id === APP_ID)
		assert(listed?.app, 'Created App is not listable')
		assert(!listed.error, 'Created App is listed with an error')
		assert(
			listed.app.manifest.title === APP_TITLE,
			'Listed App lost its manifest title',
		)
		assert(
			listed.app.manifest.iconSvg.includes('viewBox="0 0 100 100"'),
			'Listed App lost its SVG icon',
		)
		assert(!listed.app.state.pinned, 'Listed App has an unexpected pin')

		const loaded = await workspaces.load(APP_ID)
		const body = new DOMParser().parseFromString(
			loaded.content.html,
			'text/html',
		)
		assert(
			body.querySelector('#heading')?.textContent === APP_TITLE,
			'Assembled App lost its Unicode content',
		)
		assert(
			loaded.content.html.includes('data:image/svg+xml;base64,'),
			'Relative image reference was not inlined',
		)
		assert(
			!loaded.content.html.includes('<link'),
			'Stylesheet link was not extracted from the App document',
		)
		assert(
			loaded.content.css.includes('data:image/svg+xml;base64,'),
			'CSS url() asset was not inlined',
		)
		assert(
			loaded.content.css.includes('min-height: 44px'),
			'Linked stylesheet was not inlined',
		)
		assert(
			loaded.content.javascript.includes(KP_STARTUP),
			'Classic script was not inlined',
		)

		await workspaces.validate(APP_ID, signal)
		assert(
			!app.workspace.containerEl.querySelector('.ns-app-candidate'),
			'Validation sandbox leaked into the workspace',
		)
		const startupLogs = await workspaces.logs.read(APP_ID)
		assert(
			startupLogs.includes(KP_STARTUP),
			'Validated App did not write startup diagnostics',
		)
		for (const line of startupLogs
			.split('\n')
			.filter((entry) => entry.trim())) {
			const entry = JSON.parse(line) as Record<string, unknown>
			assert(entry.appId === APP_ID, 'App log entry lost its App identity')
			assert(
				!('revisionId' in entry),
				'App log entry still stores revision identity',
			)
		}

		await store.transact(APP_ID, [{ key: KP_COUNT, value: 2 }])
		assert(
			(await store.readKV(APP_ID))[KP_COUNT] === 2,
			'App KV transaction did not round-trip',
		)
		const envelope = JSON.parse(await adapter.read(appPath(APP_DATA_FILE))) as {
			schemaVersion?: number
			kv?: Record<string, unknown>
		}
		assert(envelope.schemaVersion === 1, 'App data envelope has no schema')
		assert(envelope.kv?.[KP_COUNT] === 2, 'App data envelope lost its KV')

		await workspaces.setPinned(APP_ID, true)
		await waitUntil(
			() =>
				Boolean(
					app.workspace.containerEl.querySelector(
						`[data-nutstore-app-id="${APP_ID}"]`,
					),
				),
			'pinned ribbon entry',
			async () =>
				JSON.stringify({
					pinned: (await store.read(APP_ID)).state.pinned,
					ribbons: app.workspace.containerEl.querySelectorAll(
						'[data-nutstore-app-id]',
					).length,
					listed: (await store.list()).length,
				}),
		)
		assert(
			(await store.read(APP_ID)).state.pinned,
			'Pinned App state did not persist',
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
			startupFailure.message.includes(KP_FAILURE),
			'Invalid startup was accepted',
		)
		assert(
			startupFailure.message.includes('Runtime logs:'),
			'Startup failure did not include actionable diagnostics',
		)
		assert(
			(await store.readKV(APP_ID))['临时 Temporary 🌿'] === undefined,
			'Failed startup mutated App data',
		)
		assert(
			(await workspaces.logs.read(APP_ID)).includes(KP_FAILURE),
			'Failed startup did not record diagnostics',
		)
		await adapter.write(appPath('app.js'), SCRIPT)

		// The only App-specific command opens a real App view for the requested App.
		const openPayload = await runAppOpenCommand(app, plugin)
		assert(
			openPayload.appId === APP_ID && openPayload.opened === true,
			'`app open` returned an unexpected payload',
		)
		assert(openPayload.title === APP_TITLE, '`app open` lost the App title')
		await waitUntil(
			() => {
				const leaf = app.workspace
					.getLeavesOfType(APP_VIEW_TYPE)
					.find((item) => item.view.getState().appId === APP_ID)
				return Boolean(leaf?.view.containerEl.querySelector('iframe'))
			},
			'mounted App view iframe',
			() =>
				JSON.stringify({
					leaves: app.workspace.getLeavesOfType(APP_VIEW_TYPE).map((leaf) => ({
						state: leaf.view.getState(),
						status:
							leaf.view.containerEl.querySelector('.ns-app-status')
								?.textContent,
						html: leaf.view.containerEl
							.querySelector('.ns-app-output')
							?.innerHTML.slice(0, 200),
					})),
				}),
		)
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
			frame.srcdoc.includes('"colorScheme":"'),
			'App did not receive the Obsidian color scheme',
		)
		assert(
			frame.srcdoc.includes('--font-interface') &&
				frame.srcdoc.includes('--background-modifier-border'),
			'App did not receive Obsidian theme tokens',
		)
		await new Promise((resolve) => window.setTimeout(resolve, 300))
		frame.contentWindow!.postMessage({ test: 'add' }, '*')
		await waitUntil(
			async () => (await store.readKV(APP_ID))[KP_COUNT] === 3,
			'sandbox KV round-trip',
			async () =>
				JSON.stringify({
					kv: await store.readKV(APP_ID),
					srcdoc: frame.srcdoc.length,
					sameOrigin: (() => {
						try {
							return frame.contentWindow?.document.URL
						} catch {
							return 'opaque'
						}
					})(),
				}),
		)

		// Files are the only App storage, but the host keeps lifecycle authority:
		// bash cannot mutate host-owned files or remove an App directory, and an
		// App authored from files materializes its host state on first read.
		const kvBefore = JSON.stringify(await store.readKV(APP_ID))
		await expectBlocked(
			runBash(app, plugin, `echo tampered > ${appPath(APP_DATA_FILE)}`),
			'bash could write host-owned App data',
		)
		assert(
			JSON.stringify(await store.readKV(APP_ID)) === kvBefore,
			'Blocked host-data write still changed App data',
		)

		const authoredId = 'org.example.authored'
		const authoredDirectory = appDirectoryPath(authoredId)
		const authoredManifest = JSON.stringify({
			schemaVersion: 1,
			title: '文件创建 Authored from files 🌿',
			iconSvg:
				'<svg viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="none" stroke="currentColor" stroke-width="8"/></svg>',
			dataVersion: 1,
		})
		const authoredCreate = await runBash(
			app,
			plugin,
			[
				`mkdir -p ${authoredDirectory}`,
				`echo '${authoredManifest}' > ${authoredDirectory}/${APP_MANIFEST_FILE}`,
			].join(' && '),
		)
		assert(
			authoredCreate.exitCode === 0,
			`bash could not author an App: ${authoredCreate.stderr}`,
		)
		try {
			const authored = await workspaces.load(authoredId)
			assert(
				authored.manifest.title === '文件创建 Authored from files 🌿',
				'A files-authored App lost its manifest title',
			)
			assert(
				await adapter.exists(`${authoredDirectory}/${APP_STATE_FILE}`),
				'Host state was not materialized for a files-authored App',
			)
			await expectBlocked(
				runBash(app, plugin, `rm -r ${authoredDirectory}`),
				'Bash must refuse App uninstall when no lifecycle is available',
				/ENOTSUP: App lifecycle is unavailable/,
			)
			assert(
				await store.exists(authoredId),
				'Blocked App deletion still removed the App',
			)
			assert(
				await adapter.exists(`${authoredDirectory}/${APP_MANIFEST_FILE}`),
				'Blocked App deletion still removed its manifest',
			)
		} finally {
			if (await store.exists(authoredId)) await workspaces.remove(authoredId)
		}

		// Hot reload: the source file change is observed by the debounced App view
		// after a production-bundle host state notification. (The harness bundle
		// has its own local-vault-io listener set, so it writes files directly.)
		const reloadEvents: Array<string | undefined> = []
		const unsubscribe = store.subscribe((appId) => reloadEvents.push(appId))
		await adapter.write(
			appPath(APP_ENTRY_FILE),
			htmlSource('<p id="reloaded">完成 Done 中文 🌿</p>'),
		)
		await workspaces.setPinned(APP_ID, true)
		await waitUntil(
			() => reloadEvents.includes(APP_ID),
			'App store notification for a host state write',
			async () =>
				JSON.stringify({
					events: reloadEvents,
					pinned: (await store.read(APP_ID)).state.pinned,
					file: await adapter.exists(appPath(APP_ENTRY_FILE)),
				}),
		)
		unsubscribe()
		await waitUntil(
			() => {
				const current = app.workspace
					.getLeavesOfType(APP_VIEW_TYPE)
					.find((item) => item.view.getState().appId === APP_ID)
				const currentFrame = current?.view.containerEl.querySelector('iframe')
				return Boolean(currentFrame?.srcdoc.includes('完成 Done 中文 🌿'))
			},
			'App view reload after a source file change',
			() =>
				JSON.stringify({
					frames: app.workspace
						.getLeavesOfType(APP_VIEW_TYPE)
						.flatMap((current) =>
							[...current.view.containerEl.querySelectorAll('iframe')].map(
								(currentFrame) => currentFrame.srcdoc.length,
							),
						),
					status: app.workspace
						.getLeavesOfType(APP_VIEW_TYPE)[0]
						?.view.containerEl.querySelector('.ns-app-status')?.textContent,
				}),
		)

		leaf.detach()
		await workspaces.remove(APP_ID)
		assert(
			!(await adapter.exists(directoryPath())),
			'Deleting an App left its directory behind',
		)
		assert(
			!(await store.list()).some((item) => item.id === APP_ID),
			'Deleted App is still listable',
		)
	} finally {
		for (const leaf of app.workspace.getLeavesOfType(APP_VIEW_TYPE))
			leaf.detach()
		try {
			if (await store.exists(APP_ID)) await workspaces.remove(APP_ID)
			if (await store.exists('org.example.authored'))
				await workspaces.remove('org.example.authored')
		} catch {
			// Report the original check failure, not a cleanup failure.
		}
	}
}

async function runBash(app: App, plugin: NutstorePlugin, command: string) {
	const manager = new VaultFileSystemManager(app, {
		openApp: async (appId) => {
			const opened = await plugin.ai.openApp(appId)
			if (!opened) throw new Error('The App did not open')
			return { appId, title: opened.manifest.title }
		},
	})
	return execVaultBash(app, command, {
		fileSystemManager: manager,
		signal: plugin.ai.lifecycle.scope.signal,
	})
}

/** Exercise the production bridge/serialized client in a real opaque-origin iframe, without paid inference. */
export async function runsAppAIThroughSandbox(app: App) {
	const plugin = pluginFor(app)
	assert(plugin, 'Production plugin is not loaded')
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
				.find((leaf) => leaf.view.getState().appId === id)
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

async function runAppOpenCommand(app: App, plugin: NutstorePlugin) {
	let lastError: unknown
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const result = await runBash(app, plugin, `app open ${APP_ID}`)
			if (result.exitCode === 0)
				return JSON.parse(result.stdout) as {
					appId: string
					title: string
					opened: boolean
				}
			lastError = new Error(
				`app open exited with ${result.exitCode}: ${result.stderr}`,
			)
		} catch (error) {
			lastError = error
		}
		// The tools layer can still be settling when this check runs; retry once.
		await new Promise((resolve) => window.setTimeout(resolve, 250))
	}
	if (lastError instanceof Error) throw lastError
	throw new Error('app open failed', { cause: lastError })
}
