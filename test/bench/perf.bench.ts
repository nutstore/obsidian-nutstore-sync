import { bench, describe } from 'vitest'
import { LogRetention } from '~/services/log-retention'
import { SyncScope } from '~/sync/scope'
import {
	compileFilterRules,
	isPathIncluded,
	type GlobFilterRule,
} from '~/utils/glob-match'
import { traverseLocalVault } from '~/utils/traverse-local-vault'
import { MemoryVault } from '../harness/memory-vault'

describe('SyncScope large protected-root lookup', () => {
	const scope = new SyncScope()
	const count = 10_000
	for (let i = 0; i < count; i += 1) {
		scope.report({
			path: `目录 Folder ${i}🌱/子目录`,
			operation: 'list',
			cause: new Error('Unavailable'),
		})
	}

	bench(
		'allows + includes across 1,000 queries with 10,000 protected roots',
		() => {
			for (let i = 0; i < 1_000; i += 1) {
				scope.allows(`笔记 Note ${i}📘.md`, { subtree: true })
				scope.includes(`目录 Folder ${i}🌱/子目录/文件.md`)
			}
		},
	)
})

describe('Gitignore rule evaluation throughput', () => {
	const rules: GlobFilterRule[] = [
		{ expr: '*.log', type: 'exclude', options: { caseSensitive: false } },
		{
			expr: 'node_modules/',
			type: 'exclude',
			options: { caseSensitive: true },
		},
		{ expr: 'drafts/**', type: 'exclude', options: { caseSensitive: true } },
		{
			expr: 'drafts/keep/*.md',
			type: 'include',
			options: { caseSensitive: true },
		},
		{ expr: '归档🌱/**', type: 'exclude', options: { caseSensitive: true } },
	]
	const compiled = compileFilterRules(rules)
	const paths = Array.from(
		{ length: 2_000 },
		(_, i) => `notes/section-${i % 20}/文档-${i}🌱.md`,
	)

	bench('evaluates 2,000 paths against 5 compiled rules', () => {
		for (const p of paths) {
			isPathIncluded(p, compiled, false)
		}
	})
})

describe('Local vault traversal', () => {
	const vault = new MemoryVault({ name: 'BenchVault' })
	for (let i = 0; i < 1_000; i += 1) {
		vault.seedFile(`folder-${i % 25}/note-${i}🌱.md`, `content ${i}`)
	}

	bench('traverses 1,000-file vault', async () => {
		await traverseLocalVault(vault.vault, '/')
	})
})

describe('LogRetention chunk compression throughput', () => {
	bench('appends and compresses 10,000 CJK/Emoji log lines', () => {
		const retention = new LogRetention()
		for (let i = 0; i < 10_000; i += 1) {
			retention.append(`[2026-11-23 12:00:00] [info] 批量同步记录 🌱 ${i}`)
		}
	})
})
