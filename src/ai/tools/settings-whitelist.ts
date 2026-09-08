import { parse as bytesParse } from 'bytes-iec'
import { clamp, isNil, isNumber } from 'lodash-es'
import i18n from '~/i18n'
import type { NutstoreSettings } from '~/settings'
import type { GlobFilterRule } from '~/utils/glob-match'
import GlobMatch, { isVoidGlobMatchOptions } from '~/utils/glob-match'
import { normalizeByteSizeInput } from '~/utils/download-chunk-size'

/**
 * The subset of plugin settings the AI agent is allowed to read and modify
 * through the virtual settings file under the mountable filesystem.
 *
 * Deliberately excludes credentials (account, credential, oauth response),
 * enterprise base URL, and AI provider secrets.
 */

export type WhitelistFilterRule = {
	expr: string
	type: 'include' | 'exclude'
	caseSensitive?: boolean
	disabled?: boolean
}

export type SettingsWhitelistFile = {
	filterRules?: { rules: WhitelistFilterRule[] }
	skipLargeFiles?: { maxSize?: string }
	startupSyncDelaySeconds?: number
	autoSyncIntervalSeconds?: number
	realtimeSync?: boolean
	confirmBeforeSync?: boolean
	confirmBeforeDeleteInAutoSync?: boolean
	syncMode?: NutstoreSettings['syncMode']
	conflictStrategy?: NutstoreSettings['conflictStrategy']
	configDirSyncMode?: 'none' | 'bookmarks' | 'all'
	language?: 'zh' | 'en' | ''
}

export type NormalizedSettingsPatch = {
	filterRules?: GlobFilterRule[]
	skipLargeFilesMaxSize?: string
	startupSyncDelaySeconds?: number
	autoSyncIntervalSeconds?: number
	realtimeSync?: boolean
	confirmBeforeSync?: boolean
	confirmBeforeDeleteInAutoSync?: boolean
	syncMode?: NutstoreSettings['syncMode']
	conflictStrategy?: NutstoreSettings['conflictStrategy']
	configDirSyncMode?: 'none' | 'bookmarks' | 'all'
	language?: 'zh' | 'en' | ''
}

export type SettingsParseResult =
	| { ok: true; patch: NormalizedSettingsPatch; text: string }
	| { ok: false; error: string }

export function applyNormalizedSettingsPatch(
	settings: NutstoreSettings,
	patch: NormalizedSettingsPatch,
) {
	if (patch.filterRules !== undefined) {
		settings.filterRules = { rules: patch.filterRules }
	}
	if (patch.skipLargeFilesMaxSize !== undefined) {
		settings.skipLargeFiles = { maxSize: patch.skipLargeFilesMaxSize }
	}
	if (patch.startupSyncDelaySeconds !== undefined) {
		settings.startupSyncDelaySeconds = patch.startupSyncDelaySeconds
	}
	if (patch.autoSyncIntervalSeconds !== undefined) {
		settings.autoSyncIntervalSeconds = patch.autoSyncIntervalSeconds
	}
	if (patch.realtimeSync !== undefined) {
		settings.realtimeSync = patch.realtimeSync
	}
	if (patch.confirmBeforeSync !== undefined) {
		settings.confirmBeforeSync = patch.confirmBeforeSync
	}
	if (patch.confirmBeforeDeleteInAutoSync !== undefined) {
		settings.confirmBeforeDeleteInAutoSync = patch.confirmBeforeDeleteInAutoSync
	}
	if (patch.syncMode !== undefined) {
		settings.syncMode = patch.syncMode
	}
	if (patch.conflictStrategy !== undefined) {
		settings.conflictStrategy = patch.conflictStrategy
	}
	if (patch.configDirSyncMode !== undefined) {
		settings.configDirSyncMode = patch.configDirSyncMode
	}
	if (patch.language !== undefined) {
		settings.language = patch.language || undefined
	}
}

const MAX_FILE_SIZE = '500MB'
const MAX_BYTES = bytesParse(MAX_FILE_SIZE, { mode: 'jedec' })!

const MAX_FILTER_RULES = 200
const MAX_SECONDS = 86400

const CONFLICT_STRATEGIES = new Set<string>([
	'no-conflict-merge',
	'diff3',
	'local-priority',
	'server-priority',
])
const SYNC_MODES = new Set<string>(['strict', 'loose'])
const CONFIG_DIR_SYNC_MODES = new Set<string>(['none', 'bookmarks', 'all'])
const LANGUAGES = new Set<string>(['zh', 'en', ''])
const FILTER_RULE_TYPES = new Set<string>(['include', 'exclude'])

const WHITELIST_KEYS = new Set([
	'filterRules',
	'skipLargeFiles',
	'startupSyncDelaySeconds',
	'autoSyncIntervalSeconds',
	'realtimeSync',
	'confirmBeforeSync',
	'confirmBeforeDeleteInAutoSync',
	'syncMode',
	'conflictStrategy',
	'configDirSyncMode',
	'language',
])

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function jsonError(fieldPath: string, expected: string): string {
	return `invalid setting '${fieldPath}': expected ${expected}`
}

function normalizeFilterRule(
	path: string,
	value: unknown,
	index: number,
	rules: GlobFilterRule[],
): string | null {
	const name = `${path}.rules[${index}]`
	if (!isObject(value)) {
		return jsonError(name, 'an object')
	}
	const expr = value.expr
	if (typeof expr !== 'string' || expr.trim() === '') {
		return jsonError(`${name}.expr`, 'a non-empty string')
	}
	const type = value.type
	if (typeof type !== 'string' || !FILTER_RULE_TYPES.has(type)) {
		return jsonError(`${name}.type`, "'include' or 'exclude'")
	}
	const caseSensitive = value.caseSensitive
	if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
		return jsonError(`${name}.caseSensitive`, 'a boolean')
	}
	const disabled = value.disabled
	if (disabled !== undefined && typeof disabled !== 'boolean') {
		return jsonError(`${name}.disabled`, 'a boolean')
	}
	const options = { caseSensitive: caseSensitive === true }
	const rule: GlobFilterRule = {
		expr,
		options,
		type: type as 'include' | 'exclude',
		...(disabled === true ? { disabled: true } : {}),
	}
	if (isVoidGlobMatchOptions(rule)) {
		return jsonError(`${name}.expr`, 'a non-empty pattern')
	}
	try {
		new GlobMatch(expr, options)
	} catch {
		return jsonError(`${name}.expr`, 'a valid glob pattern')
	}
	rules.push(rule)
	return null
}

function parseFilterRules(
	path: string,
	value: unknown,
): {
	rules: GlobFilterRule[]
	error: string | null
} {
	if (!isObject(value)) {
		return { rules: [], error: jsonError(path, 'an object with a rules array') }
	}
	if (!Array.isArray(value.rules)) {
		return { rules: [], error: jsonError(`${path}.rules`, 'an array') }
	}
	if (value.rules.length > MAX_FILTER_RULES) {
		return {
			rules: [],
			error: `invalid setting '${path}.rules': too many rules (max ${MAX_FILTER_RULES})`,
		}
	}
	const rules: GlobFilterRule[] = []
	for (let index = 0; index < value.rules.length; index += 1) {
		const error = normalizeFilterRule(path, value.rules[index], index, rules)
		if (error) {
			return { rules: [], error }
		}
	}
	return { rules, error: null }
}

function parseByteSize(
	path: string,
	value: unknown,
): {
	size: string | null
	error: string | null
} {
	if (typeof value !== 'string') {
		return { size: null, error: jsonError(path, 'a byte size string') }
	}
	const normalized = normalizeByteSizeInput(value, '')
	if (!normalized) {
		return {
			size: null,
			error: jsonError(path, 'a non-empty byte size string'),
		}
	}
	const parsed = bytesParse(normalized, { mode: 'jedec' })
	if (parsed === null) {
		return { size: null, error: jsonError(path, 'a valid byte size string') }
	}
	if (parsed > MAX_BYTES) {
		return {
			size: null,
			error: `invalid setting '${path}': exceeds the maximum of ${MAX_FILE_SIZE}`,
		}
	}
	return { size: normalized, error: null }
}

function parseClampedInteger(
	path: string,
	value: unknown,
	min: number,
	max: number,
): { number: number | null; error: string | null } {
	if (
		typeof value !== 'number' ||
		!isNumber(value) ||
		!Number.isFinite(value)
	) {
		return { number: null, error: jsonError(path, 'a number') }
	}
	return { number: clamp(value, min, max), error: null }
}

function parseBoolean(
	path: string,
	value: unknown,
): {
	boolean: boolean | null
	error: string | null
} {
	if (value !== true && value !== false) {
		return { boolean: null, error: jsonError(path, 'a boolean') }
	}
	return { boolean: value, error: null }
}

function parseEnum(
	path: string,
	value: unknown,
	allowed: Set<string>,
	label: string,
): { value: string | null; error: string | null } {
	if (typeof value !== 'string' || !allowed.has(value)) {
		return { value: null, error: jsonError(path, label) }
	}
	return { value, error: null }
}

export function parseSettingsWhitelistJson(text: string): SettingsParseResult {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return {
			ok: false,
			error: 'invalid setting file: not valid JSON',
		}
	}
	if (!isObject(parsed)) {
		return {
			ok: false,
			error: 'invalid setting file: expected a JSON object',
		}
	}
	for (const key of Object.keys(parsed)) {
		if (!WHITELIST_KEYS.has(key)) {
			return {
				ok: false,
				error: `invalid setting file: unknown key '${key}' is not allowed`,
			}
		}
	}

	const patch: NormalizedSettingsPatch = {}

	if (!isNil(parsed.filterRules)) {
		const { rules, error } = parseFilterRules('filterRules', parsed.filterRules)
		if (error) {
			return { ok: false, error }
		}
		patch.filterRules = rules
	}
	if (!isNil(parsed.skipLargeFiles)) {
		if (!isObject(parsed.skipLargeFiles)) {
			return {
				ok: false,
				error: jsonError('skipLargeFiles', 'an object with maxSize'),
			}
		}
		const { size, error } = parseByteSize(
			'skipLargeFiles.maxSize',
			parsed.skipLargeFiles.maxSize,
		)
		if (error) {
			return { ok: false, error }
		}
		patch.skipLargeFilesMaxSize = size!
	}
	if (!isNil(parsed.startupSyncDelaySeconds)) {
		const { number, error } = parseClampedInteger(
			'startupSyncDelaySeconds',
			parsed.startupSyncDelaySeconds,
			0,
			MAX_SECONDS,
		)
		if (error) {
			return { ok: false, error }
		}
		patch.startupSyncDelaySeconds = number!
	}
	if (!isNil(parsed.autoSyncIntervalSeconds)) {
		const { number, error } = parseClampedInteger(
			'autoSyncIntervalSeconds',
			parsed.autoSyncIntervalSeconds,
			0,
			MAX_SECONDS,
		)
		if (error) {
			return { ok: false, error }
		}
		patch.autoSyncIntervalSeconds = number!
	}
	for (const key of [
		'realtimeSync',
		'confirmBeforeSync',
		'confirmBeforeDeleteInAutoSync',
	] as const) {
		if (isNil(parsed[key])) {
			continue
		}
		const { boolean, error } = parseBoolean(key, parsed[key])
		if (error) {
			return { ok: false, error }
		}
		;(patch as Record<string, unknown>)[key] = boolean!
	}
	if (!isNil(parsed.syncMode)) {
		const { value, error } = parseEnum(
			'syncMode',
			parsed.syncMode,
			SYNC_MODES,
			"'strict' or 'loose'",
		)
		if (error) {
			return { ok: false, error }
		}
		patch.syncMode = value as NutstoreSettings['syncMode']
	}
	if (!isNil(parsed.conflictStrategy)) {
		const { value, error } = parseEnum(
			'conflictStrategy',
			parsed.conflictStrategy,
			CONFLICT_STRATEGIES,
			'a supported conflict strategy',
		)
		if (error) {
			return { ok: false, error }
		}
		patch.conflictStrategy = value as NutstoreSettings['conflictStrategy']
	}
	if (!isNil(parsed.configDirSyncMode)) {
		const { value, error } = parseEnum(
			'configDirSyncMode',
			parsed.configDirSyncMode,
			CONFIG_DIR_SYNC_MODES,
			"'none', 'bookmarks', or 'all'",
		)
		if (error) {
			return { ok: false, error }
		}
		patch.configDirSyncMode = value as 'none' | 'bookmarks' | 'all'
	}
	if (!isNil(parsed.language)) {
		const { value, error } = parseEnum(
			'language',
			parsed.language,
			LANGUAGES,
			"'zh', 'en', or an empty string",
		)
		if (error) {
			return { ok: false, error }
		}
		patch.language = value as 'zh' | 'en' | ''
	}

	const hasChanges =
		Object.keys(patch).length > 0 ||
		(patch.filterRules !== undefined && patch.filterRules.length === 0)
	if (!hasChanges) {
		return {
			ok: false,
			error: 'invalid setting file: no supported settings were provided',
		}
	}
	return { ok: true, patch, text }
}

export function serializeSettingsWhitelist(settings: NutstoreSettings): string {
	const file: SettingsWhitelistFile = {
		filterRules: {
			rules: (settings.filterRules?.rules ?? []).map((rule) => ({
				expr: rule.expr,
				type: rule.type,
				caseSensitive: rule.options.caseSensitive === true,
				disabled: rule.disabled === true ? true : undefined,
			})),
		},
		skipLargeFiles: { maxSize: settings.skipLargeFiles?.maxSize },
		startupSyncDelaySeconds: settings.startupSyncDelaySeconds,
		autoSyncIntervalSeconds: settings.autoSyncIntervalSeconds,
		realtimeSync: settings.realtimeSync,
		confirmBeforeSync: settings.confirmBeforeSync,
		confirmBeforeDeleteInAutoSync: settings.confirmBeforeDeleteInAutoSync,
		syncMode: settings.syncMode,
		conflictStrategy: settings.conflictStrategy,
		configDirSyncMode: settings.configDirSyncMode ?? 'none',
		language: settings.language ?? '',
	}
	return `${JSON.stringify(file, null, 2)}\n`
}

function areFilterRulesEqual(
	currentRules: GlobFilterRule[],
	nextRules: GlobFilterRule[],
) {
	if (currentRules.length !== nextRules.length) {
		return false
	}
	return currentRules.every((currentRule, index) => {
		const nextRule = nextRules[index]
		return (
			currentRule.expr === nextRule.expr &&
			currentRule.type === nextRule.type &&
			currentRule.options.caseSensitive === nextRule.options.caseSensitive &&
			(currentRule.disabled === true) === (nextRule.disabled === true)
		)
	})
}

function areByteSizesEqual(current: string | undefined, next: string) {
	if (current === next) {
		return true
	}
	const currentBytes = current ? bytesParse(current, { mode: 'jedec' }) : null
	const nextBytes = bytesParse(next, { mode: 'jedec' })
	return (
		currentBytes !== null && nextBytes !== null && currentBytes === nextBytes
	)
}

export function getChangedSettingsPatch(
	settings: NutstoreSettings,
	patch: NormalizedSettingsPatch,
): NormalizedSettingsPatch {
	const changes: NormalizedSettingsPatch = {}
	if (
		patch.filterRules !== undefined &&
		!areFilterRulesEqual(settings.filterRules?.rules ?? [], patch.filterRules)
	) {
		changes.filterRules = patch.filterRules
	}
	if (
		patch.skipLargeFilesMaxSize !== undefined &&
		!areByteSizesEqual(
			settings.skipLargeFiles?.maxSize,
			patch.skipLargeFilesMaxSize,
		)
	) {
		changes.skipLargeFilesMaxSize = patch.skipLargeFilesMaxSize
	}
	if (
		patch.startupSyncDelaySeconds !== undefined &&
		patch.startupSyncDelaySeconds !== settings.startupSyncDelaySeconds
	) {
		changes.startupSyncDelaySeconds = patch.startupSyncDelaySeconds
	}
	if (
		patch.autoSyncIntervalSeconds !== undefined &&
		patch.autoSyncIntervalSeconds !== settings.autoSyncIntervalSeconds
	) {
		changes.autoSyncIntervalSeconds = patch.autoSyncIntervalSeconds
	}
	if (
		patch.realtimeSync !== undefined &&
		patch.realtimeSync !== settings.realtimeSync
	) {
		changes.realtimeSync = patch.realtimeSync
	}
	if (
		patch.confirmBeforeSync !== undefined &&
		patch.confirmBeforeSync !== settings.confirmBeforeSync
	) {
		changes.confirmBeforeSync = patch.confirmBeforeSync
	}
	if (
		patch.confirmBeforeDeleteInAutoSync !== undefined &&
		patch.confirmBeforeDeleteInAutoSync !==
			settings.confirmBeforeDeleteInAutoSync
	) {
		changes.confirmBeforeDeleteInAutoSync = patch.confirmBeforeDeleteInAutoSync
	}
	if (patch.syncMode !== undefined && patch.syncMode !== settings.syncMode) {
		changes.syncMode = patch.syncMode
	}
	if (
		patch.conflictStrategy !== undefined &&
		patch.conflictStrategy !== settings.conflictStrategy
	) {
		changes.conflictStrategy = patch.conflictStrategy
	}
	if (
		patch.configDirSyncMode !== undefined &&
		patch.configDirSyncMode !== (settings.configDirSyncMode ?? 'none')
	) {
		changes.configDirSyncMode = patch.configDirSyncMode
	}
	if (
		patch.language !== undefined &&
		patch.language !== (settings.language ?? '')
	) {
		changes.language = patch.language
	}
	return changes
}

function describeFilterRules(patch: NormalizedSettingsPatch): string {
	const rules = patch.filterRules ?? []
	if (rules.length === 0) {
		return i18n.t('aiPermission.settings.fields.filterRules.empty')
	}
	return rules
		.slice(0, 5)
		.map(
			(rule) =>
				`${rule.type === 'include' ? '+' : '-'} ${rule.expr}${
					rule.disabled === true
						? ` ${i18n.t('aiPermission.settings.fields.filterRules.disabled')}`
						: ''
				}`,
		)
		.join('; ')
}

export function describeSettingsPatch(
	patch: NormalizedSettingsPatch,
): string[] {
	const lines: string[] = []
	if (patch.filterRules !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.filterRules.name')}: ${describeFilterRules(patch)}`,
		)
	}
	if (patch.skipLargeFilesMaxSize !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.skipLargeFiles.name')}: ${patch.skipLargeFilesMaxSize}`,
		)
	}
	if (patch.startupSyncDelaySeconds !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.startupSyncDelay.name')}: ${patch.startupSyncDelaySeconds}s`,
		)
	}
	if (patch.autoSyncIntervalSeconds !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.autoSyncInterval.name')}: ${Math.round(patch.autoSyncIntervalSeconds / 60)}min`,
		)
	}
	if (patch.realtimeSync !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.realtimeSync.name')}: ${i18n.t(patch.realtimeSync ? 'aiPermission.settings.on' : 'aiPermission.settings.off')}`,
		)
	}
	if (patch.confirmBeforeSync !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.confirmBeforeSync.name')}: ${i18n.t(patch.confirmBeforeSync ? 'aiPermission.settings.on' : 'aiPermission.settings.off')}`,
		)
	}
	if (patch.confirmBeforeDeleteInAutoSync !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.confirmBeforeDeleteInAutoSync.name')}: ${i18n.t(patch.confirmBeforeDeleteInAutoSync ? 'aiPermission.settings.on' : 'aiPermission.settings.off')}`,
		)
	}
	if (patch.syncMode !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.syncMode.name')}: ${patch.syncMode}`,
		)
	}
	if (patch.conflictStrategy !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.conflictStrategy.name')}: ${patch.conflictStrategy}`,
		)
	}
	if (patch.configDirSyncMode !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.configDirSyncMode.name')}: ${patch.configDirSyncMode}`,
		)
	}
	if (patch.language !== undefined) {
		lines.push(
			`${i18n.t('aiPermission.settings.fields.language.name')}: ${patch.language === '' ? i18n.t('aiPermission.settings.fields.language.auto') : patch.language}`,
		)
	}
	return lines
}
