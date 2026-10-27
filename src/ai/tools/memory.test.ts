import { InMemoryFs } from 'just-bash/browser'
import { describe, expect, it, vi } from 'vitest'
import { listMemoryEntries, discloseMemoryNote } from '~/ai/memory/memory-note'
import { MemoryRepository } from '~/ai/memory/repository'
import { decodeReversibleFileSnapshot } from '~/ai/chat/messages/reversible-content'
import { ReversibleFs } from './bash/reversible-fs'
import { createVaultFileSystem } from './vault-filesystem'
import { memoryTool } from './memory'

// These tests use the real reversible filesystem and recorder, with no native app.
vi.mock('obsidian', () => ({}))
vi.mock('./vault-filesystem', () => ({ createVaultFileSystem: vi.fn() }))

const PATH = '.agents/nutstore-sync/记忆 Memory 🧠.md'
const FIRST = 'Prefers metric units 偏好公制单位 📏'
const SECOND = 'Weekly review 每周复盘 🗓️'

async function setup(note = `${FIRST}\r\n${SECOND}`) {
	const fs = new InMemoryFs()
	await fs.writeFile(`/${PATH}`, note)
	const memory = new MemoryRepository({} as never, () => ({
		enabled: true,
		path: PATH,
	}))
	vi.mocked(createVaultFileSystem).mockImplementation(
		async (_app, options) => new ReversibleFs(fs, options!.recorder!),
	)
	const recordMetadata = vi.fn()
	return {
		fs,
		memory,
		recordMetadata,
		options: {
			toolCallId: 'memory-edit',
			messages: [],
			context: { app: {} as never, memory, recordMetadata },
		},
	}
}

describe('memory tool line protocol', () => {
	it('returns fresh references and records exact before/after snapshots for undo', async () => {
		const note = `${FIRST}\r\n${SECOND}`
		const { fs, options, recordMetadata } = await setup(note)
		const input = {
			forget: [listMemoryEntries(note)[1].id],
			remember: ['Drafts in inbox 草稿收件箱 📥'],
		}
		const result = await memoryTool.execute!(input, options)
		const after = `${FIRST}\r\nDrafts in inbox 草稿收件箱 📥\r\n`
		expect(await fs.readFile(`/${PATH}`)).toBe(after)
		expect(result).toMatchObject({
			forgotten: [SECOND],
			memory: discloseMemoryNote(PATH, after),
		})
		if (!('memory' in result))
			throw new Error('Expected completed memory edit 预期已完成记忆修改 🧠')
		const modelOutput = await memoryTool.toModelOutput!({
			toolCallId: options.toolCallId,
			input,
			output: result,
		})
		expect(modelOutput).toMatchObject({
			type: 'text',
			value: expect.stringContaining(discloseMemoryNote(PATH, after).content),
		})
		const operations = recordMetadata.mock.calls[0][1].reversibleOps
		expect(operations).toHaveLength(1)
		const operation = operations[0]
		expect(operation.operation).toBe('update')
		const decode = async (
			snapshot: Parameters<typeof decodeReversibleFileSnapshot>[0],
		) => new TextDecoder().decode(await decodeReversibleFileSnapshot(snapshot))
		expect(await decode(operation.before)).toBe(note)
		expect(await decode(operation.after)).toBe(after)
	})

	it('rejects stale IDs without changing the file or recording an undo operation', async () => {
		const { fs, memory, options, recordMetadata } = await setup()
		const stale = listMemoryEntries(`${FIRST}\r\n${SECOND}`)[1].id
		const changed = `${FIRST}\r\nMonthly review 每月复盘 🗓️`
		await fs.writeFile(`/${PATH}`, changed)
		await expect(
			memoryTool.execute!(
				{ forget: [stale], remember: ['Drafts in inbox 草稿收件箱 📥'] },
				options,
			),
		).rejects.toThrow(discloseMemoryNote(PATH, changed).content)
		expect(await fs.readFile(`/${PATH}`)).toBe(changed)
		expect(recordMetadata).not.toHaveBeenCalled()
		expect(memory.getEntries()).toEqual(listMemoryEntries(changed))
	})

	it('does not record a file change for an exact duplicate remember', async () => {
		const { fs, options, recordMetadata } = await setup(FIRST)
		await memoryTool.execute!({ remember: [FIRST], forget: [] }, options)
		expect(await fs.readFile(`/${PATH}`)).toBe(FIRST)
		expect(recordMetadata.mock.calls[0][1].reversibleOps).toEqual([])
	})
})
