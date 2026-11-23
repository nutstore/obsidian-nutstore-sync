import { Plugin } from 'obsidian'
import { OBSIDIAN_E2E_RESULT_PATH } from './integration-protocol.mjs'
import { createsIndependentApps, runsAppAIThroughSandbox } from './checks/apps'
import {
	hotTogglesFeatureModules,
	keepsChatboxMobileLayoutAndWorkspacePickerStable,
	loadsProductionPlugin,
	opensChatboxInChosenLocationAndSetupFlow,
	reloadsAndDetachesProductionPlugin,
	rendersSearchableSettingsAndVaultSkills,
	rendersSyncProgressAndScanIssues,
	respectsSessionAppOpenMode,
	type LifecycleStep,
} from './checks/plugin'

interface TestResult {
	name: string
	error?: string
}

/**
 * Slim real-Obsidian integration harness.
 *
 * Every check runs exclusively against the loaded production `main.js` plugin
 * instance (`app.plugins.plugins['nutstore-sync']`) and focuses solely on true
 * Obsidian host boundaries (Electron/WebView CSS, opaque-origin iframe sandbox,
 * native Settings search, workspace splits, and plugin enable/disable lifecycle).
 */
export default class NutstoreSyncIntegrationHarness extends Plugin {
	async onload() {
		const results: TestResult[] = []
		await this.app.vault.adapter.write(
			OBSIDIAN_E2E_RESULT_PATH,
			JSON.stringify({ passed: false, started: true, results }),
		)
		this.app.workspace.onLayoutReady(() => {
			void this.runChecks(results)
		})
	}

	private async runChecks(results: TestResult[]) {
		const lifecycleSteps: LifecycleStep[] = []
		let activeCheck: { name: string; startedAt: string } | undefined
		const writeSnapshot = () =>
			this.app.vault.adapter.write(
				OBSIDIAN_E2E_RESULT_PATH,
				JSON.stringify(
					{
						passed: false,
						started: true,
						results,
						lifecycleSteps,
						activeCheck,
					},
					null,
					2,
				),
			)

		const recordStep = async (step: LifecycleStep) => {
			lifecycleSteps.push(step)
			await writeSnapshot()
		}

		const run = async (name: string, check: () => Promise<void>) => {
			activeCheck = { name, startedAt: new Date().toISOString() }
			await writeSnapshot()
			try {
				await check()
				results.push({ name })
			} catch (error) {
				results.push({
					name,
					error: error instanceof Error ? error.stack : String(error),
				})
			}
			activeCheck = undefined
			await writeSnapshot()
		}

		await run('loads the production plugin', () =>
			loadsProductionPlugin(this.app),
		)
		await run(
			'opens Chatbox in setup and chosen workspace locations without losing session or Unicode draft',
			() => opensChatboxInChosenLocationAndSetupFlow(this.app),
		)
		await run(
			'keeps Chatbox above phone navigation and keeps the workspace picker stable across pointer down',
			() => keepsChatboxMobileLayoutAndWorkspacePickerStable(this.app),
		)
		await run(
			'respects automatic and manual session App opening independently of Chatbox location',
			() => respectsSessionAppOpenMode(this.app),
		)
		await run(
			'creates independent Apps with persistent data, theme tokens, opaque iframe KV, and hot reload',
			() => createsIndependentApps(this.app),
		)
		await run(
			'streams App AI and executes App tools through the production opaque-origin sandbox',
			() => runsAppAIThroughSandbox(this.app),
		)
		await run(
			'renders searchable Obsidian settings and persists Vault Skill toggles',
			() => rendersSearchableSettingsAndVaultSkills(this.app, recordStep),
		)
		await run(
			'renders sync progress and production ScanIssuesModal handoff',
			() => rendersSyncProgressAndScanIssues(this.app),
		)
		await run(
			'hot toggles Sync and AI feature modules and persists cold-reload state',
			() => hotTogglesFeatureModules(this.app),
		)
		await run(
			'reloads the production plugin and detaches ChatBox cleanly on disable',
			() => reloadsAndDetachesProductionPlugin(this.app, recordStep),
		)

		await this.app.vault.adapter.write(
			OBSIDIAN_E2E_RESULT_PATH,
			JSON.stringify(
				{
					passed: results.every((result) => !result.error),
					results,
					lifecycleSteps,
				},
				null,
				2,
			),
		)
	}
}
