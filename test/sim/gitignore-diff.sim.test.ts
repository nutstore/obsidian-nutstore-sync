import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	compileFilterRules,
	isPathIncluded,
	type GlobFilterRule,
} from '~/utils/glob-match'
import { simParams } from '../harness/sim-config'

function hasGitBinary(): boolean {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

const SEGMENTS = [
	'notes',
	'drafts',
	'assets',
	'build',
	'tmp',
	'笔记',
	'归档🌱',
	'a.md',
	'b.txt',
	'report.log',
	'示例🌱.md',
	'image.png',
]

const candidatePathArb = fc
	.tuple(
		fc.array(
			fc.constantFrom(
				'notes',
				'drafts',
				'assets',
				'build',
				'tmp',
				'笔记',
				'归档🌱',
			),
			{
				minLength: 0,
				maxLength: 3,
			},
		),
		fc.constantFrom('a.md', 'b.txt', 'report.log', '示例🌱.md', 'image.png'),
	)
	.map(([dirs, file]) => (dirs.length ? `${dirs.join('/')}/${file}` : file))

const patternExprArb = fc.oneof(
	fc.constantFrom(
		'*.log',
		'*.md',
		'*.txt',
		'build/',
		'tmp/',
		'drafts/**',
		'/notes/*.md',
		'**/report.log',
		'notes/**/a.md',
		'归档🌱/',
		'示例🌱.md',
		'笔记/*.md',
		'?.txt',
		'[ab].*',
		'assets/',
		'notes/drafts',
	),
	fc.constantFrom(...SEGMENTS),
)

const ruleArb: fc.Arbitrary<GlobFilterRule> = fc.record({
	expr: patternExprArb,
	type: fc.constantFrom<'include' | 'exclude'>('exclude', 'exclude', 'include'),
	options: fc.constant({ caseSensitive: true }),
})

describe.skipIf(!hasGitBinary())(
	'Live git check-ignore differential oracle',
	() => {
		let repoDir: string

		beforeAll(() => {
			repoDir = mkdtempSync(join(tmpdir(), 'ns-gitignore-diff-'))
			execFileSync('git', ['init', '-q'], { cwd: repoDir })
			execFileSync('git', ['config', 'core.ignorecase', 'false'], {
				cwd: repoDir,
			})
			execFileSync('git', ['config', 'core.quotepath', 'false'], {
				cwd: repoDir,
			})
		})

		afterAll(() => {
			rmSync(repoDir, { recursive: true, force: true })
		})

		function gitCheckIgnored(
			rules: readonly GlobFilterRule[],
			paths: readonly string[],
		): Set<string> {
			const gitignoreContent = rules
				.map((rule) => (rule.type === 'include' ? `!${rule.expr}` : rule.expr))
				.join('\n')
			writeFileSync(
				join(repoDir, '.gitignore'),
				`${gitignoreContent}\n`,
				'utf8',
			)

			const input = `${paths.join('\0')}\0`
			try {
				const out = execFileSync(
					'git',
					['check-ignore', '--no-index', '-z', '--stdin'],
					{
						cwd: repoDir,
						input,
						encoding: 'utf8',
					},
				)
				return new Set(out.split('\0').filter(Boolean))
			} catch (error) {
				// `git check-ignore` exits with status 1 when none of the paths are ignored.
				const status = (error as { status?: number }).status
				if (status === 1) {
					return new Set()
				}
				throw error
			}
		}

		it('matches real `git check-ignore` 1:1 across randomly generated rule sets and Unicode paths', () => {
			fc.assert(
				fc.property(
					fc.array(ruleArb, { minLength: 1, maxLength: 6 }),
					fc.uniqueArray(candidatePathArb, { minLength: 4, maxLength: 14 }),
					(rules, paths) => {
						const compiled = compileFilterRules(rules)
						const gitIgnored = gitCheckIgnored(rules, paths)

						for (const candidate of paths) {
							const actualIncluded = isPathIncluded(candidate, compiled, false)
							const expectedIncluded = !gitIgnored.has(candidate)
							expect(
								actualIncluded,
								`Divergence on path="${candidate}" with rules=${JSON.stringify(
									rules.map((r) => `${r.type}:${r.expr}`),
								)}`,
							).toBe(expectedIncluded)
						}
					},
				),
				simParams(40, 501),
			)
		})
	},
)
