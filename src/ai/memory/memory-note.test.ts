import { InMemoryFs } from 'just-bash/browser'
import { describe, expect, it } from 'vitest'
import {
	DEFAULT_MEMORY_NOTE_PATH,
	describeMemoryEdit,
	discloseMemoryNote,
	editMemoryNote,
	listMemoryEntries,
	MEMORY_ENTRY_CHARACTER_LIMIT,
	MEMORY_NOTE_CHARACTER_LIMIT,
	MemoryEditError,
	normalizeMemoryNotePath,
} from './memory-note'
import { MemoryRepository } from './repository'

const NOTE = [
	'# 记忆 Memory 🧠',
	'',
	'Notes kept by hand 手写说明.',
	'',
	'- Prefers metric units 偏好公制单位 📏',
	'* Weekly review on Fridays 每周五复盘 🗓️',
	'  - nested detail 嵌套细节',
	'',
	'## Elsewhere 其他',
	'',
].join('\n')

describe('memory entries', () => {
	it('lists only top-level list items, normalized to one line', () => {
		expect(listMemoryEntries(NOTE)).toEqual([
			'Prefers metric units 偏好公制单位 📏',
			'Weekly review on Fridays 每周五复盘 🗓️',
		])
		expect(listMemoryEntries('+   Spaced\t entry 空白 ✨\r\n')).toEqual([
			'Spaced entry 空白 ✨',
		])
	})
})

describe('editMemoryNote', () => {
	it('appends after the last entry and keeps everything the user wrote', () => {
		const result = editMemoryNote(NOTE, {
			remember: ['Drafts live in the inbox folder 草稿放在收件箱 📥'],
			forget: [],
		})
		expect(result.content).toBe(
			[
				'# 记忆 Memory 🧠',
				'',
				'Notes kept by hand 手写说明.',
				'',
				'- Prefers metric units 偏好公制单位 📏',
				'* Weekly review on Fridays 每周五复盘 🗓️',
				'  - nested detail 嵌套细节',
				'- Drafts live in the inbox folder 草稿放在收件箱 📥',
				'',
				'## Elsewhere 其他',
				'',
			].join('\n'),
		)
		expect(result).toMatchObject({
			remembered: ['Drafts live in the inbox folder 草稿放在收件箱 📥'],
			forgotten: [],
			unchanged: [],
			entryCount: 3,
		})
	})

	it('corrects an entry by forgetting and remembering in one edit', () => {
		const result = editMemoryNote(NOTE, {
			forget: ['Weekly review on Fridays 每周五复盘 🗓️'],
			remember: ['Weekly review on Mondays 每周一复盘 🗓️'],
		})
		expect(listMemoryEntries(result.content)).toEqual([
			'Prefers metric units 偏好公制单位 📏',
			'Weekly review on Mondays 每周一复盘 🗓️',
		])
		expect(result.content).toContain('Notes kept by hand 手写说明.')
	})

	it('starts an empty note with plain entries and skips duplicates', () => {
		const result = editMemoryNote('', {
			remember: [
				'Uses dark theme 深色主题 🌙',
				' Uses  dark theme 深色主题 🌙 ',
			],
			forget: [],
		})
		expect(result.content).toBe('- Uses dark theme 深色主题 🌙\n')
		expect(
			editMemoryNote(result.content, {
				remember: ['Uses dark theme 深色主题 🌙'],
				forget: [],
			}),
		).toMatchObject({
			content: result.content,
			remembered: [],
			unchanged: ['Uses dark theme 深色主题 🌙'],
		})
	})

	it('preserves CRLF line endings', () => {
		const result = editMemoryNote('- One 一 1️⃣\r\n', {
			remember: ['Two 二 2️⃣'],
			forget: [],
		})
		expect(result.content).toBe('- One 一 1️⃣\r\n- Two 二 2️⃣\r\n')
	})

	it('rejects the whole edit when an entry to forget is not in memory', () => {
		expect(() =>
			editMemoryNote(NOTE, {
				remember: ['New fact 新事实 🆕'],
				forget: ['Not remembered 未记住 ❓'],
			}),
		).toThrow(MemoryEditError)
	})

	it('rejects empty edits and overlong entries', () => {
		expect(() => editMemoryNote(NOTE, { remember: [' '], forget: [] })).toThrow(
			MemoryEditError,
		)
		expect(() =>
			editMemoryNote(NOTE, {
				remember: ['长'.repeat(MEMORY_ENTRY_CHARACTER_LIMIT + 1)],
				forget: [],
			}),
		).toThrow(`at most ${MEMORY_ENTRY_CHARACTER_LIMIT} characters`)
	})

	it('refuses to grow a full note but still allows it to shrink', () => {
		const entry = '满'.repeat(MEMORY_ENTRY_CHARACTER_LIMIT - 4)
		const full = Array.from(
			{ length: Math.ceil(MEMORY_NOTE_CHARACTER_LIMIT / entry.length) },
			(_, index) => `- ${index} ${entry}`,
		).join('\n')
		expect(() =>
			editMemoryNote(full, { remember: ['One more 再一条 ➕'], forget: [] }),
		).toThrow('Memory is full')
		const shrunk = editMemoryNote(full, {
			forget: [`0 ${entry}`],
			remember: [],
		})
		expect(shrunk.entryCount).toBe(listMemoryEntries(full).length - 1)
	})
})

describe('discloseMemoryNote', () => {
	it('discloses the trimmed note and truncates by characters, not bytes', () => {
		expect(discloseMemoryNote('MEMORY.md', '\n- 记住 🧠\n\n')).toEqual({
			path: 'MEMORY.md',
			content: '- 记住 🧠',
		})
		const long = discloseMemoryNote(
			'MEMORY.md',
			'🧠'.repeat(MEMORY_NOTE_CHARACTER_LIMIT + 1),
		)
		expect(long.truncated).toBe(true)
		expect(Array.from(long.content)).toHaveLength(MEMORY_NOTE_CHARACTER_LIMIT)
	})
})

describe('describeMemoryEdit', () => {
	it('names every entry an edit remembers and forgets', () => {
		expect(
			describeMemoryEdit(
				{ remember: ['New 新 🆕', 'Other 另一 ➕'], forget: ['Old 旧 📦'] },
				(action) => (action === 'remember' ? '记住' : '忘记'),
			),
		).toBe('记住: New 新 🆕; Other 另一 ➕ · 忘记: Old 旧 📦')
		expect(describeMemoryEdit({}, () => 'unused')).toBe('')
	})
})

describe('normalizeMemoryNotePath', () => {
	it('accepts Markdown files in the plugin memory directory', () => {
		expect(normalizeMemoryNotePath(DEFAULT_MEMORY_NOTE_PATH)).toBe(
			'.agents/nutstore-sync/MEMORY.md',
		)
		expect(
			normalizeMemoryNotePath(' /.agents/nutstore-sync/偏好\\\\记忆 🧠.MD/ '),
		).toBe('.agents/nutstore-sync/偏好/记忆 🧠.MD')
	})

	it('rejects hidden, escaping, empty and non-Markdown paths', () => {
		for (const path of [
			'',
			'.md',
			'notes/.md',
			'.agents/memory.md',
			'notes/../memory.md',
			'notes/./memory.md',
			'MEMORY.md',
			'.agents/nutstore-sync/../memory.md',
			'.agents/nutstore-sync/.hidden/memory.md',
			'memory.txt',
			'notes/',
		]) {
			expect(normalizeMemoryNotePath(path)).toBeUndefined()
		}
	})
})

describe('MemoryRepository.edit', () => {
	function createRepository(path = '.agents/nutstore-sync/偏好/记忆 🧠.md') {
		return new MemoryRepository({ vault: { adapter: {} } } as never, () => ({
			enabled: true,
			path,
		}))
	}

	it('clears cached memory when reading a newly configured file fails', async () => {
		const settings = { enabled: true, path: DEFAULT_MEMORY_NOTE_PATH }
		const memory = new MemoryRepository(
			{
				vault: {
					adapter: {
						exists: async () => true,
						read: async (path: string) => {
							if (path !== DEFAULT_MEMORY_NOTE_PATH)
								throw new Error('Unavailable 文件不可用 📁')
							return '- Prefers metric units 偏好公制单位 📏\n'
						},
					},
				},
			} as never,
			() => settings,
		)
		await memory.refresh()
		expect(memory.getDisclosure()?.content).toContain('偏好公制单位 📏')
		settings.path = '.agents/nutstore-sync/偏好/记忆 🧠.md'
		await memory.refresh()
		expect(memory.getDisclosure()).toEqual({ path: settings.path, content: '' })
	})

	it('creates the note on first remember and discloses it right away', async () => {
		const fs = new InMemoryFs()
		const memory = createRepository()
		await memory.edit(fs, {
			remember: ['Prefers metric units 偏好公制单位 📏'],
			forget: [],
		})
		expect(await fs.readFile('/.agents/nutstore-sync/偏好/记忆 🧠.md')).toBe(
			'- Prefers metric units 偏好公制单位 📏\n',
		)
		expect(memory.getDisclosure()).toEqual({
			path: '.agents/nutstore-sync/偏好/记忆 🧠.md',
			content: '- Prefers metric units 偏好公制单位 📏',
		})
	})

	it('serializes parallel edits so none is lost', async () => {
		const fs = new InMemoryFs()
		const memory = createRepository()
		await Promise.all(
			['One 一 1️⃣', 'Two 二 2️⃣', 'Three 三 3️⃣'].map((entry) =>
				memory.edit(fs, { remember: [entry], forget: [] }),
			),
		)
		expect(
			listMemoryEntries(
				await fs.readFile('/.agents/nutstore-sync/偏好/记忆 🧠.md'),
			),
		).toEqual(['One 一 1️⃣', 'Two 二 2️⃣', 'Three 三 3️⃣'])
	})

	it('keeps working after a rejected edit and falls back to the default path', async () => {
		const fs = new InMemoryFs()
		const memory = createRepository('.hidden/memory.md')
		expect(memory.path).toBe(DEFAULT_MEMORY_NOTE_PATH)
		await expect(
			memory.edit(fs, { remember: [], forget: ['Missing 缺失 ❓'] }),
		).rejects.toThrow(MemoryEditError)
		await memory.edit(fs, { remember: ['Kept 保留 ✅'], forget: [] })
		expect(await fs.readFile(`/${DEFAULT_MEMORY_NOTE_PATH}`)).toBe(
			'- Kept 保留 ✅\n',
		)
	})
})
