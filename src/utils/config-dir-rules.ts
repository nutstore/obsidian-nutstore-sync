import type NutstorePlugin from '~/index'
import GlobMatch, {
	type GlobMatchOptions,
	needIncludeFromGlobRules,
} from './glob-match'
import {
	REMOTE_SYNC_CACHE_DIR,
	REMOTE_SYNC_CACHE_FILENAME,
	getSyncCacheLocalPath,
} from './sync-cache-file'

export type ConfigDirSyncMode = 'none' | 'bookmarks' | 'all'

export interface EffectiveFilterRules {
	exclusionRules: GlobMatchOptions[]
	inclusionRules: GlobMatchOptions[]
	configDir: string
	configDirSyncMode: ConfigDirSyncMode
}

export interface ConfigDirFilterRuleInput {
	exclusionRules: GlobMatchOptions[]
	inclusionRules: GlobMatchOptions[]
}

const CONFIG_DIR_SYSTEM_EXCLUSION_SUFFIXES = [
	'plugins/**/node_modules',
	'plugins/**/.git',
	'plugins/**/.pnpm-store',
	'plugins/nutstore-sync/data.local.json',
	`${REMOTE_SYNC_CACHE_DIR}/${REMOTE_SYNC_CACHE_FILENAME}`,
	'workspace',
	'workspace.json',
] as const

function makeCaseSensitiveRule(expr: string): GlobMatchOptions {
	return { expr, options: { caseSensitive: true } }
}

export function getConfigDirSystemTraversalRules(
	configDir: string,
): GlobMatchOptions[] {
	return CONFIG_DIR_SYSTEM_EXCLUSION_SUFFIXES.map((suffix) =>
		makeCaseSensitiveRule(`${configDir}/${suffix}`),
	)
}

export function getConfigDirSystemFilterRules(
	configDir: string,
): GlobMatchOptions[] {
	return getConfigDirSystemTraversalRules(configDir).flatMap((rule) => [
		makeCaseSensitiveRule(rule.expr),
		makeCaseSensitiveRule(`${rule.expr}/**`),
	])
}

/**
 * The remote traversal cache is implementation state, but its current remote
 * location is inside the vault config directory. Respect the config-directory
 * sync mode and the user's own filter rules before accessing it.
 *
 * System filter rules are intentionally not considered here: they prevent the
 * cache file from being synchronized as user content, while this check decides
 * whether the cache service may access its dedicated remote storage.
 */
export function shouldUseRemoteTraversalCache(
	configDir: string,
	mode: ConfigDirSyncMode,
	filterRules: ConfigDirFilterRuleInput,
): boolean {
	if (mode !== 'all') {
		return false
	}

	const inclusions = filterRules.inclusionRules.map(
		({ expr, options }) => new GlobMatch(expr, options),
	)
	const exclusions = filterRules.exclusionRules.map(
		({ expr, options }) => new GlobMatch(expr, options),
	)
	return needIncludeFromGlobRules(
		getSyncCacheLocalPath(configDir),
		inclusions,
		exclusions,
	)
}

export function computeEffectiveFilterRulesFromParts(
	configDir: string,
	mode: ConfigDirSyncMode,
	filterRules: ConfigDirFilterRuleInput,
): EffectiveFilterRules {
	const exclusionRules = [...filterRules.exclusionRules]
	const inclusionRules = [...filterRules.inclusionRules]
	exclusionRules.push(...getConfigDirSystemFilterRules(configDir))

	if (mode === 'none') {
		exclusionRules.push({ expr: configDir, options: { caseSensitive: false } })
	} else if (mode === 'bookmarks') {
		exclusionRules.push({
			expr: `${configDir}/**`,
			options: { caseSensitive: false },
		})
		inclusionRules.push({
			expr: `${configDir}/bookmarks.json`,
			options: { caseSensitive: false },
		})
	}
	// mode === 'all': no additional rules — configDir traversed freely

	return {
		exclusionRules,
		inclusionRules,
		configDir,
		configDirSyncMode: mode,
	}
}

/**
 * Returns true if `path` points to a file or folder inside this plugin's own
 * directory `<configDir>/plugins/nutstore-sync/` (or that directory itself).
 *
 * The plugin must never delete its own files during sync — when the remote
 * vault simply does not have the plugin installed, the local plugin files
 * should be preserved, not removed. Used by mirror deciders to short-circuit
 * self-deletion.
 */
export function isPluginSelfPath(path: string, configDir: string): boolean {
	const pluginDir = `${configDir}/plugins/nutstore-sync`
	return path === pluginDir || path.startsWith(`${pluginDir}/`)
}

/**
 * Computes the effective exclusion/inclusion filter rules by merging the
 * user's stored rules with the system-managed configDir rules derived from
 * the current configDirSyncMode setting.
 *
 * Does NOT modify plugin.settings — returns a new rule set for use at
 * sync time only.
 */
export function computeEffectiveFilterRules(
	plugin: NutstorePlugin,
): EffectiveFilterRules {
	const configDir = plugin.app.vault.configDir
	const mode: ConfigDirSyncMode = plugin.settings.configDirSyncMode ?? 'none'
	return computeEffectiveFilterRulesFromParts(
		configDir,
		mode,
		plugin.settings.filterRules,
	)
}
