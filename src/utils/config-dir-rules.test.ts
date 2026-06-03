import { describe, expect, it } from 'vitest'
import {
	computeEffectiveFilterRules,
	getConfigDirSystemFilterRules,
	getConfigDirSystemTraversalRules,
} from './config-dir-rules'
import GlobMatch, { needIncludeFromGlobRules } from './glob-match'

function createPluginMock(
	mode: 'none' | 'bookmarks' | 'all',
	filterRules = {
		exclusionRules: [] as {
			expr: string
			options: { caseSensitive: boolean }
		}[],
		inclusionRules: [] as {
			expr: string
			options: { caseSensitive: boolean }
		}[],
	},
) {
	return {
		app: {
			vault: {
				configDir: '.obsidian',
			},
		},
		settings: {
			configDirSyncMode: mode,
			filterRules,
		},
	} as any
}

describe('computeEffectiveFilterRules', () => {
	it('generates traversal and filter rules from shared system source', () => {
		const traversalRules = getConfigDirSystemTraversalRules('.obsidian')
		const filterRules = getConfigDirSystemFilterRules('.obsidian')

		expect(traversalRules).toEqual([
			{
				expr: '.obsidian/plugins/**/node_modules',
				options: { caseSensitive: true },
			},
			{ expr: '.obsidian/plugins/**/.git', options: { caseSensitive: true } },
			{
				expr: '.obsidian/plugins/**/.pnpm-store',
				options: { caseSensitive: true },
			},
			{
				expr: '.obsidian/plugins/nutstore-sync/cache/ObsidianNutstoreSync.SyncCache.v1',
				options: { caseSensitive: true },
			},
			{ expr: '.obsidian/workspace', options: { caseSensitive: true } },
			{ expr: '.obsidian/workspace.json', options: { caseSensitive: true } },
		])
		expect(filterRules).toEqual(
			expect.arrayContaining([
				{
					expr: '.obsidian/plugins/**/node_modules',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/**/node_modules/**',
					options: { caseSensitive: true },
				},
				{ expr: '.obsidian/plugins/**/.git', options: { caseSensitive: true } },
				{
					expr: '.obsidian/plugins/**/.git/**',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/**/.pnpm-store',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/**/.pnpm-store/**',
					options: { caseSensitive: true },
				},
			]),
		)
	})

	it('keeps user configDir whitelist rules in all mode', () => {
		const rules = computeEffectiveFilterRules(
			createPluginMock('all', {
				exclusionRules: [
					{ expr: '.obsidian/**', options: { caseSensitive: false } },
				],
				inclusionRules: [
					{
						expr: '.obsidian/snippets/file-tree-colors.css',
						options: { caseSensitive: false },
					},
					{
						expr: '.obsidian/plugins/manual-sorting/data.json',
						options: { caseSensitive: false },
					},
				],
			}),
		)
		const exclusions = rules.exclusionRules.map(
			(rule) => new GlobMatch(rule.expr, rule.options),
		)
		const inclusions = rules.inclusionRules.map(
			(rule) => new GlobMatch(rule.expr, rule.options),
		)

		expect(
			needIncludeFromGlobRules(
				'.obsidian/snippets/file-tree-colors.css',
				inclusions,
				exclusions,
			),
		).toBe(true)
		expect(
			needIncludeFromGlobRules(
				'.obsidian/plugins/manual-sorting/data.json',
				inclusions,
				exclusions,
			),
		).toBe(true)
		expect(
			needIncludeFromGlobRules('.obsidian/app.json', inclusions, exclusions),
		).toBe(false)
	})

	it('allows user inclusions to override mode-derived configDir exclusions', () => {
		const rules = computeEffectiveFilterRules(
			createPluginMock('none', {
				exclusionRules: [],
				inclusionRules: [
					{
						expr: '.obsidian/bookmarks.json',
						options: { caseSensitive: false },
					},
				],
			}),
		)
		const exclusions = rules.exclusionRules.map(
			(rule) => new GlobMatch(rule.expr, rule.options),
		)
		const inclusions = rules.inclusionRules.map(
			(rule) => new GlobMatch(rule.expr, rule.options),
		)

		expect(
			needIncludeFromGlobRules(
				'.obsidian/bookmarks.json',
				inclusions,
				exclusions,
			),
		).toBe(true)
		expect(
			needIncludeFromGlobRules('.obsidian/app.json', inclusions, exclusions),
		).toBe(false)
	})

	it('allows user inclusions to extend bookmarks mode', () => {
		const rules = computeEffectiveFilterRules(
			createPluginMock('bookmarks', {
				exclusionRules: [],
				inclusionRules: [
					{
						expr: '.obsidian/snippets/file-tree-colors.css',
						options: { caseSensitive: false },
					},
				],
			}),
		)
		const exclusions = rules.exclusionRules.map(
			(rule) => new GlobMatch(rule.expr, rule.options),
		)
		const inclusions = rules.inclusionRules.map(
			(rule) => new GlobMatch(rule.expr, rule.options),
		)

		expect(
			needIncludeFromGlobRules(
				'.obsidian/bookmarks.json',
				inclusions,
				exclusions,
			),
		).toBe(true)
		expect(
			needIncludeFromGlobRules(
				'.obsidian/snippets/file-tree-colors.css',
				inclusions,
				exclusions,
			),
		).toBe(true)
		expect(
			needIncludeFromGlobRules('.obsidian/app.json', inclusions, exclusions),
		).toBe(false)
	})

	it('adds plugin dependency exclusions in all mode', () => {
		const rules = computeEffectiveFilterRules(createPluginMock('all'))
		expect(rules.exclusionRules).toEqual(
			expect.arrayContaining([
				{
					expr: '.obsidian/plugins/**/node_modules',
					options: { caseSensitive: true },
				},
				{ expr: '.obsidian/plugins/**/.git', options: { caseSensitive: true } },
				{
					expr: '.obsidian/plugins/**/.git/**',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/**/.pnpm-store',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/**/.pnpm-store/**',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/**/node_modules/**',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/nutstore-sync/cache/ObsidianNutstoreSync.SyncCache.v1',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/nutstore-sync/cache/ObsidianNutstoreSync.SyncCache.v1/**',
					options: { caseSensitive: true },
				},
			]),
		)
	})

	it.each(['none', 'bookmarks', 'all'] as const)(
		'excludes the automatic remote sync cache file in %s mode',
		(mode) => {
			const rules = computeEffectiveFilterRules(createPluginMock(mode))
			const exclusions = rules.exclusionRules.map(
				(rule) => new GlobMatch(rule.expr, rule.options),
			)
			const inclusions = rules.inclusionRules.map(
				(rule) => new GlobMatch(rule.expr, rule.options),
			)

			expect(
				needIncludeFromGlobRules(
					'.obsidian/plugins/nutstore-sync/cache/ObsidianNutstoreSync.SyncCache.v1',
					inclusions,
					exclusions,
				),
			).toBe(false)
		},
	)

	it('uses mode-derived rules as normal glob rules', () => {
		const inclusion = [new GlobMatch('**/*.json', { caseSensitive: false })]
		const exclusion = [new GlobMatch('.obsidian', { caseSensitive: false })]
		expect(
			needIncludeFromGlobRules(
				'.obsidian/workspace.json',
				inclusion,
				exclusion,
			),
		).toBe(true)
	})
})
