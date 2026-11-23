import type { App } from 'obsidian'
import { describe, expect, it, vi } from 'vitest'
import { MemoryVault } from '@test/harness/memory-vault'
import { decodeReversibleFileSnapshot } from '~/ai/chat/messages/reversible-content'
import type { ReversibleToolOp } from '~/ai/chat/types'
import { applyHunks, applyPatchTool, parsePatch } from './apply-patch'
import { createFragmentReadTracker } from './file-operation'

function createReadTracker(paths: string[] = []) {
	return createFragmentReadTracker({ readVaultPaths: [...paths] })
}

describe('apply-patch correctness and performance', () => {
	it('does not scan the vault index or .agents directory when applying a patch', async () => {
		const mem = new MemoryVault({ name: 'DirectPatchVault' })
		mem.seedFile('notes/文档🌱.md', '第一行\n旧内容\n第三行\n')
		mem.seedFile('.agents/nutstore-sync/sessions/s1.json', '{"id":"s1"}')
		mem.seedFile('.agents/skills/demo/SKILL.md', '---\nname: demo\n---\n')

		const app = mem.app as unknown as App
		const listSpy = vi.spyOn(app.vault.adapter, 'list')
		const allLoadedSpy = vi.spyOn(app.vault, 'getAllLoadedFiles')

		const patch = [
			'*** Begin Patch',
			'*** Update File: notes/文档🌱.md',
			'@@',
			' 第一行',
			'-旧内容',
			'+新内容 🚀',
			' 第三行',
			'*** End Patch',
		].join('\n')

		const result = await applyPatchTool.execute!(
			{ purpose: '更新中性笔记 🌱', patch },
			{
				toolCallId: 'patch-no-scan',
				messages: [],
				context: {
					app,
					readTracker: createReadTracker(['notes/文档🌱.md']),
				},
			},
		)

		expect(result).toEqual({ applied: true, files: ['notes/文档🌱.md'] })
		expect(mem.readTextDirect('notes/文档🌱.md')).toBe(
			'第一行\n新内容 🚀\n第三行\n',
		)
		expect(listSpy).not.toHaveBeenCalled()
		expect(allLoadedSpy).not.toHaveBeenCalled()
	})

	it('preserves exact overlapping ambiguity counts and handles repeated lines in linear time', () => {
		const overlapping =
			['重复行 🌱', '重复行 🌱', '重复行 🌱'].join('\n') + '\n'
		const overlappingPatch = parsePatch(
			[
				'*** Begin Patch',
				'*** Update File: notes/overlap.md',
				'@@',
				' 重复行 🌱',
				'-重复行 🌱',
				'+替换行 🌿',
				'*** End Patch',
			].join('\n'),
		)
		const overlappingOp = overlappingPatch[0]
		expect(overlappingOp.kind).toBe('update')
		if (overlappingOp.kind === 'update') {
			expect(() =>
				applyHunks(overlapping, overlappingOp.hunks, overlappingOp.path),
			).toThrow(/matched 2 locations/)
		}

		// Pathological repeated prefix that would degrade naive nested matching to O(n*m).
		const repeatedLines = [
			...Array.from({ length: 20_000 }, () => ''),
			'终点标记 🧭',
		]
		const repeatedPatch = parsePatch(
			[
				'*** Begin Patch',
				'*** Update File: notes/repeated.md',
				'@@',
				...Array.from({ length: 250 }, () => ' '),
				'-终点标记 🧭',
				'+完成标记 ✅',
				'*** End Patch',
			].join('\n'),
		)
		const repeatedOp = repeatedPatch[0]
		expect(repeatedOp.kind).toBe('update')
		if (repeatedOp.kind === 'update') {
			const updated = applyHunks(
				`${repeatedLines.join('\n')}\n`,
				repeatedOp.hunks,
				repeatedOp.path,
			)
			expect(updated.endsWith('\n完成标记 ✅\n')).toBe(true)
		}
	})

	it('applies large insertions beyond JS argument-spread limits without stack overflow', () => {
		const inserted = Array.from(
			{ length: 75_000 },
			(_, index) => `行 ${index} neutral line 🌱`,
		)
		const hunks = [
			{
				header: '',
				endOfFile: false,
				lines: [
					{ kind: 'context' as const, text: '头部 header' },
					...inserted.map((text) => ({ kind: 'add' as const, text })),
					{ kind: 'context' as const, text: '尾部 footer' },
				],
			},
		]
		const result = applyHunks('头部 header\n尾部 footer\n', hunks, 'large.md')
		expect(result.startsWith('头部 header\n行 0 neutral line 🌱\n')).toBe(true)
		expect(result.endsWith('行 74999 neutral line 🌱\n尾部 footer\n')).toBe(
			true,
		)
	})

	it('records minimal net reversible operations when updating and moving a file', async () => {
		const mem = new MemoryVault({ name: 'UpdateMoveVault' })
		const original = '标题：旧文档 🌱\n第二行\n'
		mem.seedFile('notes/旧路径🌱.md', original)
		const app = mem.app as unknown as App
		let recorded: ReversibleToolOp[] = []

		const patch = [
			'*** Begin Patch',
			'*** Update File: notes/旧路径🌱.md',
			'*** Move to: archive/新路径🌿.md',
			'@@',
			'-标题：旧文档 🌱',
			'+标题：新文档 🌿',
			' 第二行',
			'*** End Patch',
		].join('\n')

		const result = await applyPatchTool.execute!(
			{ purpose: '更新并归档笔记 🌿', patch },
			{
				toolCallId: 'patch-move',
				messages: [],
				context: {
					app,
					readTracker: createReadTracker(['notes/旧路径🌱.md']),
					recordMetadata: (_id, metadata) => {
						recorded = metadata.reversibleOps ?? []
					},
				},
			},
		)

		expect(result).toEqual({
			applied: true,
			files: ['notes/旧路径🌱.md', 'archive/新路径🌿.md'],
		})
		expect(mem.readTextDirect('notes/旧路径🌱.md')).toBeUndefined()
		expect(mem.readTextDirect('archive/新路径🌿.md')).toBe(
			'标题：新文档 🌿\n第二行\n',
		)

		const deletedOp = recorded.find(
			(op) => op.operation === 'delete' && op.vaultPath === 'notes/旧路径🌱.md',
		)
		const createdOp = recorded.find(
			(op) =>
				op.operation === 'create' && op.vaultPath === 'archive/新路径🌿.md',
		)
		expect(deletedOp).toBeDefined()
		expect(createdOp).toBeDefined()
		if (deletedOp?.operation === 'delete' && deletedOp.before.kind === 'file') {
			const beforeBytes = await decodeReversibleFileSnapshot(deletedOp.before)
			expect(new TextDecoder('utf-8').decode(beforeBytes)).toBe(original)
		}
		if (createdOp?.operation === 'create' && createdOp.after?.kind === 'file') {
			const afterBytes = await decodeReversibleFileSnapshot(createdOp.after)
			expect(new TextDecoder('utf-8').decode(afterBytes)).toBe(
				'标题：新文档 🌿\n第二行\n',
			)
		}
	})

	it('reports fileNotFound when patching a missing file that was previously marked read', async () => {
		const mem = new MemoryVault({ name: 'MissingPatchVault' })
		const patch = [
			'*** Begin Patch',
			'*** Update File: notes/不存在🌱.md',
			'@@',
			'-a',
			'+b',
			'*** End Patch',
		].join('\n')

		await expect(
			applyPatchTool.execute!(
				{ purpose: '验证缺失文件报错', patch },
				{
					toolCallId: 'patch-missing',
					messages: [],
					context: {
						app: mem.app as unknown as App,
						readTracker: createReadTracker(['notes/不存在🌱.md']),
					},
				},
			),
		).rejects.toThrow(/notes\/不存在🌱\.md/)
	})
})
