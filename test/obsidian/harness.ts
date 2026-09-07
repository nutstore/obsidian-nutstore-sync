import { Plugin } from 'obsidian'
import { persistsChatSessions, toleratesCorruptChatMeta } from './checks/chat'
import {
	detachesChatboxWhenProductionPluginIsDisabled,
	loadsProductionPlugin,
	reloadsProductionPlugin,
	rendersSyncProgress,
} from './checks/plugin'
import { createsProviderModels } from './checks/providers'
import {
	excludesUnrelatedHiddenPathsFromGlobSnapshot,
	expandsAgentDomainPathsInBash,
	expandsExistingVaultPathsInBash,
	preservesBashHeredocUtf8,
	resolvesResourceDataUrls,
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
		const writeSnapshot = () =>
			this.app.vault.adapter.write(
				OBSIDIAN_E2E_RESULT_PATH,
				JSON.stringify({ passed: false, started: true, results }, null, 2),
			)

		const run = async (name: string, check: () => Promise<void>) => {
			try {
				await check()
				results.push({ name })
			} catch (error) {
				results.push({
					name,
					error: error instanceof Error ? error.stack : String(error),
				})
			}
			// Record progress per check: a hung check must still leave every
			// completed result behind for failure diagnostics.
			await writeSnapshot()
		}

		await run('loads the production plugin', () =>
			loadsProductionPlugin(this.app),
		)
		await run('creates provider models through the real Obsidian runtime', () =>
			createsProviderModels(),
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
		await run('detaches ChatBox when the production plugin is disabled', () =>
			detachesChatboxWhenProductionPluginIsDisabled(this.app),
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
		await run('tolerates a corrupt chat meta file', () =>
			toleratesCorruptChatMeta(this.app),
		)
		await run(
			'renders sync progress through the loaded production plugin',
			() => rendersSyncProgress(this.app),
		)

		await this.app.vault.adapter.write(
			OBSIDIAN_E2E_RESULT_PATH,
			JSON.stringify(
				{ passed: results.every((result) => !result.error), results },
				null,
				2,
			),
		)
	}
}
