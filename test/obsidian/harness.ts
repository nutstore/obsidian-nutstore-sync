import { Plugin } from 'obsidian'
import {
	exportsImagesThroughBrowserTransport,
	persistsChatSessions,
	toleratesCorruptChatMeta,
} from './checks/chat'
import {
	detachesChatboxWhenProductionPluginIsDisabled,
	listsOnlyVaultSkillsInSettings,
	loadsProductionPlugin,
	reloadsProductionPlugin,
	rendersSearchableSettings,
	rendersSyncProgress,
	type LifecycleStep,
} from './checks/plugin'
import {
	excludesUnrelatedHiddenPathsFromGlobSnapshot,
	expandsAgentDomainPathsInBash,
	expandsExistingVaultPathsInBash,
	filtersDisabledSkillsFromAgentCatalog,
	preservesBashHeredocUtf8,
	resolvesResourceDataUrls,
	respectsVaultDeletionPreference,
	roundTripsVaultAdapterContent,
	skipsStaleVaultSkillEntries,
} from './checks/vault'

export const OBSIDIAN_E2E_RESULT_PATH =
	'.obsidian/nutstore-sync-e2e-result.json'

interface TestResult {
	name: string
	error?: string
}

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
			// Record progress per check: a hung check must still leave every
			// completed result behind for failure diagnostics.
			await writeSnapshot()
		}

		await run('loads the production plugin', () =>
			loadsProductionPlugin(this.app),
		)
		await run('reloads the production plugin through the real lifecycle', () =>
			reloadsProductionPlugin(this.app),
		)
		await run('expands existing Vault paths in Bash wildcards', () =>
			expandsExistingVaultPathsInBash(this.app),
		)
		await run('excludes unrelated hidden paths from Bash wildcards', () =>
			excludesUnrelatedHiddenPathsFromGlobSnapshot(this.app),
		)
		await run('expands plugin agent domain paths in Bash wildcards', () =>
			expandsAgentDomainPathsInBash(this.app),
		)
		await run('round-trips Vault adapter paths and content', () =>
			roundTripsVaultAdapterContent(this.app),
		)
		await run(
			'preserves UTF-8 when Bash writes a Vault file through a heredoc',
			() => preservesBashHeredocUtf8(this.app),
		)
		await run('resolves resource data URLs through the real DataAdapter', () =>
			resolvesResourceDataUrls(this.app),
		)
		await run('persists chat sessions through the real DataAdapter', () =>
			persistsChatSessions(this.app),
		)
		await run(
			'skips a stale Vault Skill entry without hiding stable Skills',
			() => skipsStaleVaultSkillEntries(this.app),
		)
		await run(
			'hides disabled Vault Skills while keeping built-in Skills active',
			() => filtersDisabledSkillsFromAgentCatalog(this.app),
		)
		await run(
			'respects deletion preferences without a permanent-delete fallback',
			() => respectsVaultDeletionPreference(this.app),
		)
		await run(
			'exports remote and local images without the native HTTP bridge',
			() => exportsImagesThroughBrowserTransport(this.app),
		)

		await run(
			'renders searchable settings through shared section renderers',
			() => rendersSearchableSettings(this.app),
		)
		await run('lists only Vault Skills in the Skills settings', () =>
			listsOnlyVaultSkillsInSettings(this.app),
		)

		await run('tolerates a corrupt chat meta file', () =>
			toleratesCorruptChatMeta(this.app),
		)
		await run(
			'renders sync progress through the loaded production plugin',
			() => rendersSyncProgress(this.app),
		)

		await run('detaches ChatBox when the production plugin is disabled', () =>
			detachesChatboxWhenProductionPluginIsDisabled(this.app, async (step) => {
				lifecycleSteps.push(step)
				await writeSnapshot()
			}),
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
