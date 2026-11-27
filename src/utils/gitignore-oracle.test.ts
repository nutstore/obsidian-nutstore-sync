import { describe, expect, it } from 'vitest'
import { compileFilterRules, isPathIncluded } from './glob-match'

/**
 * Curated regression fixtures covering subtle gitignore semantics (slashless
 * basename matching, anchoring, directory-only trailing slash, `**`, negation,
 * and CJK/Emoji paths). Broad randomized parity against real `git check-ignore`
 * runs in `test/sim/gitignore-diff.sim.test.ts`.
 */
const CASES: ReadonlyArray<{
	name: string
	rules: Array<['exclude' | 'include', string]>
	path: string
	isDir?: boolean
	included: boolean
}> = [
	{
		name: 'slashless include does not re-include file under matching ancestor',
		rules: [
			['exclude', '*.md'],
			['include', 'assets'],
		],
		path: 'assets/a.md',
		included: false,
	},
	{
		name: 'slashless pattern matches leaf filename at any depth',
		rules: [['exclude', '*.log']],
		path: 'a/b/debug.log',
		included: false,
	},
	{
		name: 'leading slash anchors to vault root',
		rules: [['exclude', '/root.md']],
		path: 'sub/root.md',
		included: true,
	},
	{
		name: 'anchored rule matches root file',
		rules: [['exclude', '/root.md']],
		path: 'root.md',
		included: false,
	},
	{
		name: 'trailing slash excludes directories and their descendants, not files',
		rules: [['exclude', 'build/']],
		path: 'build',
		isDir: false,
		included: true,
	},
	{
		name: 'trailing slash excludes nested files under matched directory',
		rules: [['exclude', 'build/']],
		path: 'sub/build/out.js',
		included: false,
	},
	{
		name: 'cannot re-include file inside an excluded directory',
		rules: [
			['exclude', 'drafts/'],
			['include', 'drafts/keep.md'],
		],
		path: 'drafts/keep.md',
		included: false,
	},
	{
		name: 'can re-include file when only contents were excluded with wildcard',
		rules: [
			['exclude', 'drafts/*'],
			['include', 'drafts/keep.md'],
		],
		path: 'drafts/keep.md',
		included: true,
	},
	{
		name: 'double star matches zero or more intermediate directories',
		rules: [['exclude', 'a/**/b.md']],
		path: 'a/b.md',
		included: false,
	},
	{
		name: 'double star matches deeply nested path',
		rules: [['exclude', 'a/**/b.md']],
		path: 'a/x/y/z/b.md',
		included: false,
	},
	{
		name: 'character class and ? wildcard',
		rules: [['exclude', 'note-[0-9]?.md']],
		path: 'dir/note-4a.md',
		included: false,
	},
	{
		name: 'CJK and Emoji directory exclusion',
		rules: [['exclude', '归档🌱/']],
		path: '笔记/归档🌱/示例📘.md',
		included: false,
	},
	{
		name: 'CJK and Emoji file re-inclusion',
		rules: [
			['exclude', '笔记/*.md'],
			['include', '笔记/保留🌿.md'],
		],
		path: '笔记/保留🌿.md',
		included: true,
	},
]

describe('gitignore boundary regression cases', () => {
	it.each(CASES)('$name', ({ rules, path, isDir = false, included }) => {
		const compiled = compileFilterRules(
			rules.map(([type, expr]) => ({
				type,
				expr,
				options: { caseSensitive: true },
			})),
		)
		expect(isPathIncluded(path, compiled, isDir)).toBe(included)
	})
})
