import { bench, describe, vi } from 'vitest'

vi.mock('~/settings', () => ({
	SyncMode: { LOOSE: 'loose', STRICT: 'strict' },
}))
import { buildLineDiff } from '~/ai/chat/messages/file-diff'
import { applyHunks, parsePatch } from '~/ai/tools/apply-patch'
import type { FsWalkResult } from '~/fs/fs.interface'
import type { StatModel } from '~/model/stat.model'
import type { SyncRecordModel } from '~/model/sync-record.model'
import { LogRetention } from '~/services/log-retention'
import { SyncMode } from '~/settings'
import { diff3MergeEngine } from '~/sync/core/merge-engines/diff3-merge'
import { yjsTextMergeEngine } from '~/sync/core/merge-engines/yjs-text-merge'
import type {
	SyncDecisionInput,
	TaskFactory,
} from '~/sync/decision/sync-decision.interface'
import { twoWayDecider } from '~/sync/decision/two-way.decider'
import { SyncScope } from '~/sync/scope'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import type { BaseTask } from '~/sync/tasks/task.interface'
import { computeEffectiveFilterRulesFromParts } from '~/utils/config-dir-rules'
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

describe('apply-patch hunk application throughput', () => {
	const lines = Array.from(
		{ length: 10_000 },
		(_, i) => `line-${i}: 中性笔记内容 Neutral content 🌱`,
	)
	const content = `${lines.join('\n')}\n`
	const hunkParts = ['*** Begin Patch', '*** Update File: notes/大文档🌱.md']
	for (let h = 0; h < 20; h += 1) {
		const idx = h * 450 + 100
		hunkParts.push(`@@ line-${idx - 1}: 中性笔记内容 Neutral content 🌱`)
		hunkParts.push(` ${lines[idx]}`)
		hunkParts.push(`-${lines[idx + 1]}`)
		hunkParts.push(`+modified-${idx + 1}: 已更新内容 🚀`)
		hunkParts.push(` ${lines[idx + 2]}`)
	}
	hunkParts.push('*** End Patch')
	const parsed = parsePatch(hunkParts.join('\n'))
	const hunks = parsed[0].kind === 'update' ? parsed[0].hunks : []

	bench('applies 20 headered hunks to a 10,000-line file', () => {
		applyHunks(content, hunks, 'notes/大文档🌱.md')
	})
})

describe('FileDiff large rewrite throughput', () => {
	const beforeLines = Array.from(
		{ length: 2_000 },
		(_, i) => `- 条目 ${i}: 中性段落说明与记录内容 🌱`,
	)
	const before = `${beforeLines.join('\n')}\n`
	const after = `${beforeLines
		.map((line, i) =>
			i % 2 === 0 ? `## 章节 ${i} 📘\n重写后的中性段落内容 ${i} 🚀` : line,
		)
		.join('\n')}\n`

	bench('diffs a 2,000-line 50% rewrite', () => {
		buildLineDiff(before, after)
	})
})

describe('P0-1: Default filter rules & SyncScope multi-pass pipeline', () => {
	const eff = computeEffectiveFilterRulesFromParts('.obsidian', 'none', {
		rules: [],
	})
	const compiled = compileFilterRules(eff.rules)
	const paths = Array.from(
		{ length: 10_000 },
		(_, i) => `notes/area-${i % 20}/sub-${i % 10}/文档-${i}🌱.md`,
	)
	const entries: FsWalkResult[] = paths.map((path, i) => ({
		stat: {
			path,
			basename: `文档-${i}🌱.md`,
			isDir: false,
			isDeleted: false,
			mtime: 1000,
			size: 128,
		},
		ignored: false,
	}))
	const records = entries.map(
		(e) =>
			[e.stat.path, { local: e.stat, remote: e.stat }] as [
				string,
				SyncRecordModel,
			],
	)

	bench('evaluates 10,000 paths against 15 default effective rules', () => {
		for (const p of paths) {
			isPathIncluded(p, compiled, false)
		}
	})

	bench('runs SyncScope 5-pass pipeline across 10,000 entries', () => {
		const scope = new SyncScope(eff.rules)
		scope.observe(entries)
		scope.observe(entries)
		scope.apply(entries)
		scope.apply(entries)
		for (const [path, record] of records) {
			scope.allowsRecord(path, record)
		}
	})
})

describe('P0-2: TwoWay decider orphan record cleanup', () => {
	const count = 5_000
	const stats: FsWalkResult[] = Array.from({ length: count }, (_, i) => {
		const path = `folder-${i % 50}/笔记-${i}🌱.md`
		const stat: StatModel = {
			path,
			basename: `笔记-${i}🌱.md`,
			isDir: false,
			isDeleted: false,
			mtime: 1000,
			size: 128,
		}
		return { stat, ignored: false }
	})
	const syncRecords = new Map<string, SyncRecordModel>(
		stats.map((s) => [s.stat.path, { local: s.stat, remote: s.stat }]),
	)
	const stubTaskFactory = new Proxy({} as TaskFactory, {
		get: () => () => ({}) as BaseTask,
	})
	const input: SyncDecisionInput = {
		logger: { info() {}, debug() {}, warn() {}, error() {} },
		settings: {
			skipLargeFiles: { maxSize: '' },
			mobileAppDownloadFileChunkSize: '',
			conflictStrategy: ConflictStrategy.NoConflictMerge,
			syncMode: SyncMode.STRICT,
			configDir: '.obsidian',
		},
		localStats: stats,
		remoteStats: stats,
		syncRecords,
		remoteBaseDir: '/remote/',
		getBaseContent: async () => null,
		compareFileContent: async () => true,
		getLocalContentHash: async () => null,
		taskFactory: stubTaskFactory,
	}

	bench('decides no-op sync on 5,000 synced files', async () => {
		await twoWayDecider(input)
	})
})

describe('P0-3: Diff3 & Yjs no-base large Markdown merge', () => {
	const lineCount = 3_000
	const baseLines = Array.from({ length: lineCount }, (_, i) =>
		i % 4 === 0 ? '' : `Line ${i}: 中性段落说明 sample ${i} 🌱`,
	)
	const localLines = [...baseLines]
	localLines[10] = 'Line 10: 本地编辑 local edit 🌿'
	const remoteLines = [...baseLines]
	remoteLines[lineCount - 10] = 'Line end: 远端编辑 remote edit 📘'
	const baseText = baseLines.join('\n')
	const localText = localLines.join('\n')
	const remoteText = remoteLines.join('\n')

	bench(
		'diff3MergeEngine merges 3,000-line Markdown (25% blank, 2 edits)',
		() => {
			diff3MergeEngine.merge({
				baseContentText: baseText,
				localContentText: localText,
				remoteContentText: remoteText,
				filePath: '笔记/sample🌱.md',
				hasBase: true,
			})
		},
		{ iterations: 2, warmupIterations: 0 },
	)

	bench(
		'yjsTextMergeEngine merges 3,000-line Markdown without base (2 edits)',
		() => {
			yjsTextMergeEngine.merge({
				baseContentText: '',
				localContentText: localText,
				remoteContentText: remoteText,
				filePath: '笔记/sample🌱.md',
				hasBase: false,
			})
		},
		{ iterations: 2, warmupIterations: 0 },
	)
})
