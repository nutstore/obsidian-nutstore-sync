import { describe, expect, it } from 'vitest'
import { SyncScope } from '~/sync/scope'
import {
	compileFilterRules,
	createPathInclusionChecker,
	type GlobFilterRule,
	isPathIncluded,
} from './glob-match'

const sensitive = { caseSensitive: true }

const rule = (
	expr: string,
	type: GlobFilterRule['type'] = 'exclude',
): GlobFilterRule => ({ expr, options: sensitive, type })

const decide = (
	path: string,
	rules: GlobFilterRule[],
	isDir = path.endsWith('/'),
) => isPathIncluded(path, compileFilterRules(rules), isDir)

describe('gitignore compatibility: basename and anchoring', () => {
	it.each([
		['draft.md', false],
		['notes/draft.md', false],
		['笔记/草稿.md', true],
		['draft.md.backup', true],
	] as const)('slashless pattern: %s -> included=%s', (path, included) => {
		expect(decide(path, [rule('draft.md')])).toBe(included)
	})

	it.each([
		['docs/guide.md', false],
		['docs/章节.md', false],
		['archive/docs/guide.md', true],
		['documentation/guide.md', true],
	] as const)(
		'pattern containing slash: %s -> included=%s',
		(path, included) => {
			expect(decide(path, [rule('docs/*')])).toBe(included)
		},
	)

	it.each([
		['root-note.md', false],
		['ROOT-NOTE.md', true],
		['folder/root-note.md', true],
		['根目录/root-note.md', true],
	] as const)('root-anchored pattern: %s -> included=%s', (path, included) => {
		expect(decide(path, [rule('/root-note.md')])).toBe(included)
	})

	it('a trailing slash distinguishes a directory from a same-named file', () => {
		const rules = [rule('cache/')]
		expect(decide('cache', rules, false)).toBe(true)
		expect(decide('cache', rules, true)).toBe(false)
		expect(decide('cache/item.json', rules)).toBe(false)
		expect(decide('资料/cache/条目.json', rules)).toBe(false)
	})
})

describe('gitignore compatibility: wildcard grammar', () => {
	it.each([
		['src/result1.txt', false],
		['src/result中.txt', false],
		['src/result12.txt', true],
		['src/deep/result1.txt', true],
	] as const)(
		'* and ? do not cross a slash: %s -> included=%s',
		(path, included) => {
			expect(decide(path, [rule('src/result?.txt')])).toBe(included)
		},
	)

	it.each([
		['data-a.csv', false],
		['data-中.csv', false],
		['data-5.csv', true],
		['data-55.csv', true],
	] as const)(
		'a leading ! negates a bracket range: %s -> included=%s',
		(path, included) => {
			expect(decide(path, [rule('data-[!0-9].csv')])).toBe(included)
		},
	)

	it('brace expansion is not part of gitignore syntax', () => {
		const rules = [rule('report.{md,txt}')]
		expect(decide('report.md', rules)).toBe(true)
		expect(decide('report.txt', rules)).toBe(true)
		expect(decide('report.{md,txt}', rules)).toBe(false)
	})

	it('a backslash escapes wildcard metacharacters', () => {
		const rules = [rule(String.raw`name\?.txt`), rule(String.raw`版本\*.md`)]
		expect(decide('name?.txt', rules)).toBe(false)
		expect(decide('name1.txt', rules)).toBe(true)
		expect(decide('版本*.md', rules)).toBe(false)
		expect(decide('版本一.md', rules)).toBe(true)
	})

	it('an unmatched opening bracket is a literal character', () => {
		expect(() => compileFilterRules([rule('memo[.md')])).not.toThrow()
		expect(decide('memo[.md', [rule('memo[.md')])).toBe(false)
		expect(decide('memoA.md', [rule('memo[.md')])).toBe(true)
	})

	it('bracket expressions support POSIX character classes', () => {
		const rules = [rule('item-[[:digit:]].txt')]
		expect(decide('item-5.txt', rules)).toBe(false)
		expect(decide('item-a.txt', rules)).toBe(true)
		expect(decide('项目-五.txt', rules)).toBe(true)
	})

	it('a bracket expression cannot consume a path separator', () => {
		const rules = [rule('x[a/]y')]
		expect(decide('xay', rules)).toBe(false)
		expect(decide('x/y', rules)).toBe(true)
	})

	it('wildcards also match dot-prefixed names', () => {
		const rules = [rule('*')]
		expect(decide('.draft', rules)).toBe(false)
		expect(decide('目录/.草稿', rules)).toBe(false)
	})

	it('leading spaces are significant and unescaped trailing spaces are ignored', () => {
		expect(decide(' note.md', [rule(' note.md')])).toBe(false)
		expect(decide('note.md', [rule(' note.md')])).toBe(true)
		expect(decide('草稿.md', [rule('草稿.md   ')])).toBe(false)
		expect(decide('草稿.md   ', [rule('草稿.md   ')])).toBe(true)
	})

	it('an escaped trailing space remains part of the pattern', () => {
		const rules = [rule(String.raw`note.md\ `), rule(String.raw`笔记.md\ `)]
		expect(decide('note.md ', rules)).toBe(false)
		expect(decide('note.md', rules)).toBe(true)
		expect(decide('笔记.md ', rules)).toBe(false)
	})
})

describe('gitignore compatibility: double-star positions', () => {
	it.each([
		['a/b', false],
		['a/中/b', false],
		['a/x/y/b', false],
		['x/a/b', true],
		['a/b.txt', true],
	] as const)('a/**/b: %s -> included=%s', (path, included) => {
		expect(decide(path, [rule('a/**/b')])).toBe(included)
	})

	it.each([
		['logs', false],
		['work/logs', false],
		['工作/历史/logs', false],
		['catalogs', true],
	] as const)('leading **/: %s -> included=%s', (path, included) => {
		expect(decide(path, [rule('**/logs')])).toBe(included)
	})

	it.each([
		['archive', true],
		['archive/item.txt', false],
		['archive/资料/条目.txt', false],
		['nested/archive/item.txt', true],
	] as const)('trailing /**: %s -> included=%s', (path, included) => {
		expect(decide(path, [rule('archive/**')])).toBe(included)
	})

	it.each([
		['a/xxb/c', false],
		['a/b/c', false],
		['a/x/yb/c', true],
		['a/中b/c', false],
	] as const)(
		'** inside a segment behaves like ordinary stars: %s -> included=%s',
		(path, included) => {
			expect(decide(path, [rule('a/**b/c')])).toBe(included)
		},
	)
})

describe('gitignore compatibility: ordered include and exclude rules', () => {
	it('a leaf can be re-included when none of its parents are excluded', () => {
		const rules = [rule('*.tmp'), rule('keep.tmp', 'include')]
		expect(decide('keep.tmp', rules)).toBe(true)
		expect(decide('notes/keep.tmp', rules)).toBe(true)
		expect(decide('笔记/保留.tmp', rules)).toBe(false)
	})

	it('re-including only a leaf cannot cross an excluded parent', () => {
		const rules = [rule('private/'), rule('private/readme.md', 'include')]
		expect(decide('private/readme.md', rules)).toBe(false)
		expect(decide('private/说明.md', rules)).toBe(false)
	})

	it('each excluded ancestor must be re-included before its descendants', () => {
		const rules = [
			rule('/*'),
			rule('/docs', 'include'),
			rule('/docs/**', 'include'),
			rule('/docs/private/'),
			rule('/docs/private/公开.md', 'include'),
		]
		expect(decide('docs/guide.md', rules)).toBe(true)
		expect(decide('docs/指南.md', rules)).toBe(true)
		expect(decide('docs/private/公开.md', rules)).toBe(false)
		expect(decide('other/file.md', rules)).toBe(false)
	})

	it('the last matching rule wins independently at every ancestor', () => {
		const rules = [
			rule('workspace/'),
			rule('workspace', 'include'),
			rule('workspace/**', 'include'),
			rule('workspace/generated/'),
			rule('workspace/generated', 'include'),
			rule('workspace/generated/keep/**', 'include'),
		]
		expect(decide('workspace/notes/today.md', rules)).toBe(true)
		expect(decide('workspace/笔记/今日.md', rules)).toBe(true)
		expect(decide('workspace/generated/other.txt', rules)).toBe(true)
		expect(decide('workspace/generated/keep/item.txt', rules)).toBe(true)
	})
})

describe('gitignore compatibility: path normalization', () => {
	it.each([
		['./notes/draft.md', false],
		['notes/section/../draft.md', false],
		['/notes//draft.md', false],
		['笔记/章节/../草稿.md', false],
	] as const)('normalizes vault-relative paths: %s', (path, included) => {
		const pattern = path.includes('草稿') ? '笔记/草稿.md' : 'notes/draft.md'
		expect(decide(path, [rule(pattern)])).toBe(included)
	})

	it('an empty rule has no effect', () => {
		expect(decide('note.md', [rule(''), rule('   ')])).toBe(true)
		expect(decide('笔记.md', [rule('\t')])).toBe(true)
	})

	it('keeps createPathInclusionChecker and SyncScope consistent with isPathIncluded on dot-segment aliases', () => {
		const rules = [rule('/草稿📘/'), rule('/归档🌿')]
		const compiled = compileFilterRules(rules)
		const checker = createPathInclusionChecker(compiled)
		const scope = new SyncScope(rules)

		for (const [candidate, isDir] of [
			['草稿📘/.', true],
			['./草稿📘/.', true],
			['草稿📘/./记录.md', false],
			['笔记🌱/草稿📘/.', true],
			['归档🌿/.', false],
			['.', true],
		] as const) {
			const expected = isPathIncluded(candidate, compiled, isDir)
			expect(checker(candidate, isDir), `checker(${candidate})`).toBe(expected)
			expect(scope.allows(candidate, { isDir }), `scope(${candidate})`).toBe(
				expected,
			)
		}
		expect(scope.allows('草稿📘/.', { isDir: true })).toBe(false)
	})
})
