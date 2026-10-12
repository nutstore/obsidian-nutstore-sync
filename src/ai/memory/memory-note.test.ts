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

const METRIC = 'Prefers metric units 偏好公制单位 📏'
const REVIEW = 'Weekly review 每周复盘 🗓️'
const NOTE = [
	'# Memory 记忆 🧠',
	'',
	METRIC,
	`- ${REVIEW}`,
	'  Nested detail 缩进细节 📚',
	'',
].join('\n')

function ids(content: string) {
	return listMemoryEntries(content).map((entry) => entry.id)
}

function texts(content: string) {
	return listMemoryEntries(content).map((entry) => entry.text)
}

describe('memory lines', () => {
	it('gives every nonblank physical line an ID regardless of Markdown formatting', () => {
		expect(texts(NOTE)).toEqual([
			'# Memory 记忆 🧠',
			METRIC,
			`- ${REVIEW}`,
			'  Nested detail 缩进细节 📚',
		])
		expect(ids(NOTE)).toHaveLength(4)
		for (const id of ids(NOTE)) expect(id).toMatch(/^[a-f0-9]{12}$/)
		expect(ids(NOTE)).toEqual(ids(texts(NOTE).join('\n')))
		expect(listMemoryEntries('\r\n \t\r\n')).toEqual([])
	})

	it('keeps references deterministic and sensitive to exact Unicode text and whitespace', () => {
		expect(ids(NOTE)).toEqual(ids(NOTE))
		const original = ids(METRIC)[0]
		expect(ids(` ${METRIC}`)[0]).not.toBe(original)
		expect(ids(`${METRIC} `)[0]).not.toBe(original)
		expect(ids('Café 咖啡 ☕')[0]).not.toBe(ids('Café 咖啡 ☕')[0])
		expect(ids(METRIC + '\r\n')[0]).toBe(original)
	})

	it('uses the same UTF-8 digest as Web Crypto for bilingual emoji text', async () => {
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(METRIC),
		)
		const expected = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0'),
		)
			.join('')
			.slice(0, 12)
		expect(ids(METRIC)).toEqual([expected])
	})

	it('shares a reference for repeated lines and forgets all identical copies', () => {
		const references = ids(`${METRIC}\n\n${METRIC}`)
		expect(references[0]).toBe(references[1])
		const result = editMemoryNote(`${METRIC}\n\n${METRIC}`, {
			remember: [],
			forget: [references[1]],
		})
		expect(result.content).toBe('\n')
		expect(result.entryCount).toBe(0)
		expect(result.forgotten).toEqual([METRIC])
	})
})

describe('editMemoryNote', () => {
	it('appends plain text at EOF and preserves all existing formatting', () => {
		const addition = 'Drafts live in the inbox folder 草稿放在收件箱 📥'
		const result = editMemoryNote(NOTE, { remember: [addition], forget: [] })
		expect(result.content).toBe(NOTE + addition + '\n')
		expect(result).toMatchObject({
			remembered: [addition],
			forgotten: [],
			unchanged: [],
			entryCount: 5,
		})
	})

	it('deletes plain lines in the middle of a partially formatted note', () => {
		const note = `- ${METRIC}\n${REVIEW}\nDrafts in inbox 草稿收件箱 📥\n`
		const result = editMemoryNote(note, {
			remember: [],
			forget: [ids(note)[1]],
		})
		expect(result.content).toBe(`- ${METRIC}\nDrafts in inbox 草稿收件箱 📥\n`)
		expect(result.forgotten).toEqual([REVIEW])
	})

	it('corrects multiple lines against one snapshot before appending replacements', () => {
		const references = ids(NOTE)
		const result = editMemoryNote(NOTE, {
			forget: [references[1], references[3], references[1]],
			remember: ['Weekly review on Mondays 每周一复盘 🗓️'],
		})
		expect(result.content).toBe(
			'# Memory 记忆 🧠\n\n- ' +
				REVIEW +
				'\nWeekly review on Mondays 每周一复盘 🗓️\n',
		)
		expect(result.forgotten).toEqual([METRIC, '  Nested detail 缩进细节 📚'])
	})

	it('skips exact duplicates without folding spaces or interpreting Markdown', () => {
		const result = editMemoryNote('', {
			remember: [METRIC, METRIC, ` ${METRIC} `, `- ${METRIC}`],
			forget: [],
		})
		expect(result.content).toBe(`${METRIC}\n ${METRIC} \n- ${METRIC}\n`)
		expect(
			editMemoryNote(result.content, { remember: [METRIC], forget: [] }),
		).toMatchObject({
			content: result.content,
			remembered: [],
			unchanged: [METRIC],
		})
	})

	it('can forget and reappend the same text in one correction', () => {
		const result = editMemoryNote(METRIC, {
			forget: ids(METRIC),
			remember: [METRIC],
		})
		expect(result).toMatchObject({
			content: METRIC + '\n',
			forgotten: [METRIC],
			remembered: [METRIC],
		})
	})

	it('preserves mixed line endings, empty lines and unterminated EOF when deleting', () => {
		const note = `${METRIC}\r\n \t\n${REVIEW}\rDrafts in inbox 草稿收件箱 📥`
		const result = editMemoryNote(note, {
			remember: [],
			forget: [ids(note)[1]],
		})
		expect(result.content).toBe(
			`${METRIC}\r\n \t\nDrafts in inbox 草稿收件箱 📥`,
		)
	})

	it('separates an unterminated final line and follows the existing newline when appending', () => {
		expect(
			editMemoryNote(METRIC, { remember: [REVIEW], forget: [] }).content,
		).toBe(`${METRIC}\n${REVIEW}\n`)
		expect(
			editMemoryNote(`${METRIC}\r\n${REVIEW}`, {
				remember: ['Drafts 草稿 📥'],
				forget: [],
			}).content,
		).toBe(`${METRIC}\r\n${REVIEW}\r\nDrafts 草稿 📥\r\n`)
	})

	it('rejects text-based, malformed and stale references with the latest IDs', () => {
		const changed = NOTE.replace(
			METRIC,
			'Prefers standard units 偏好标准单位 📏',
		)
		for (const reference of [METRIC, 'invalid-hash', ids(NOTE)[1]]) {
			try {
				editMemoryNote(changed, {
					remember: ['New fact 新事实 🆕'],
					forget: [ids(changed)[0], reference],
				})
				throw new Error('Expected stale reference rejection 应拒绝过期引用 ❓')
			} catch (error) {
				expect(error).toBeInstanceOf(MemoryEditError)
				expect((error as Error).message).toContain('nothing was changed')
				expect((error as Error).message).toContain(
					discloseMemoryNote('', changed).content,
				)
			}
		}
	})

	it('keeps references valid when earlier lines are inserted, removed or reordered', () => {
		const reference = ids(NOTE)[1]
		for (const shifted of [
			'New line 新行 🆕\n' + NOTE,
			NOTE.slice(NOTE.indexOf('\n') + 1),
			texts(NOTE).reverse().join('\n'),
		]) {
			expect(ids(shifted)).toContain(reference)
			const result = editMemoryNote(shifted, {
				remember: [],
				forget: [reference],
			})
			expect(result.forgotten).toEqual([METRIC])
			expect(texts(result.content)).toEqual(
				texts(shifted).filter((text) => text !== METRIC),
			)
		}
	})

	it('rejects empty edits, blank lines, multiline inputs and overlong additions', () => {
		expect(() => editMemoryNote(NOTE, { remember: [], forget: [] })).toThrow(
			MemoryEditError,
		)
		for (const text of [
			' \t',
			`${METRIC}\n${REVIEW}`,
			`${METRIC}\r${REVIEW}`,
			`${METRIC}\u2028${REVIEW}`,
			`${METRIC}\u2029${REVIEW}`,
		]) {
			expect(() =>
				editMemoryNote(NOTE, { remember: [text], forget: [] }),
			).toThrow('one nonblank line')
		}
		expect(() =>
			editMemoryNote(NOTE, {
				remember: ['Review 复盘 🗓️'.repeat(MEMORY_ENTRY_CHARACTER_LIMIT)],
				forget: [],
			}),
		).toThrow('at most')
	})

	it('refuses to grow a full note but permits deleting hand-written overlong lines', () => {
		const full = METRIC.repeat(MEMORY_NOTE_CHARACTER_LIMIT)
		expect(() =>
			editMemoryNote(full, { remember: [REVIEW], forget: [] }),
		).toThrow('Memory is full')
		expect(
			editMemoryNote(full, { remember: [], forget: ids(full) }),
		).toMatchObject({ content: '', entryCount: 0 })
	})

	it('returns an empty file when all memory lines are removed without inventing a trailing newline', () => {
		const result = editMemoryNote(`${METRIC}\n${REVIEW}`, {
			remember: [],
			forget: ids(`${METRIC}\n${REVIEW}`),
		})
		expect(result.content).toBe('')
		expect(result.entryCount).toBe(0)
	})
})

describe('discloseMemoryNote', () => {
	it('annotates content references without changing line text', () => {
		const note = `\n ${METRIC} \n\n${REVIEW}\n`
		expect(discloseMemoryNote('MEMORY.md', note)).toEqual({
			path: 'MEMORY.md',
			content: `[${ids(note)[0]}]  ${METRIC} \n[${ids(note)[1]}] ${REVIEW}`,
		})
		expect(discloseMemoryNote('MEMORY.md', '\n \t\n')).toEqual({
			path: 'MEMORY.md',
			content: '',
		})
	})

	it('bounds annotated context and truncates only between complete Unicode lines', () => {
		const note = Array.from({ length: 400 }, () => METRIC).join('\n')
		const disclosure = discloseMemoryNote('MEMORY.md', note)
		expect(disclosure.truncated).toBe(true)
		expect(Array.from(disclosure.content).length).toBeLessThanOrEqual(
			MEMORY_NOTE_CHARACTER_LIMIT,
		)
		for (const record of disclosure.content.split('\n'))
			expect(record.endsWith(METRIC)).toBe(true)
		const oversized = discloseMemoryNote(
			'MEMORY.md',
			METRIC.repeat(MEMORY_NOTE_CHARACTER_LIMIT),
		)
		expect(oversized).toEqual({
			path: 'MEMORY.md',
			content: '',
			truncated: true,
		})
	})
})

describe('describeMemoryEdit', () => {
	it('names additions and references while preserving meaningful whitespace', () => {
		expect(
			describeMemoryEdit(
				{ remember: ['New 新 🆕', 'Other 另一 ➕'], forget: [ids(METRIC)[0]] },
				(action) => (action === 'remember' ? '记住' : '忘记'),
			),
		).toBe(`记住: New 新 🆕; Other 另一 ➕ · 忘记: ${ids(METRIC)[0]}`)
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
		expect(memory.getEntries().map((entry) => entry.text)).toEqual([
			'- Prefers metric units 偏好公制单位 📏',
		])
		settings.path = '.agents/nutstore-sync/偏好/记忆 🧠.md'
		await memory.refresh()
		expect(memory.getEntries()).toEqual([])
	})

	it('creates the note on first remember and discloses it right away', async () => {
		const fs = new InMemoryFs()
		const memory = createRepository()
		await memory.edit(fs, {
			remember: ['Prefers metric units 偏好公制单位 📏'],
			forget: [],
		})
		expect(await fs.readFile('/.agents/nutstore-sync/偏好/记忆 🧠.md')).toBe(
			'Prefers metric units 偏好公制单位 📏\n',
		)
		expect(memory.getEntries()).toEqual(listMemoryEntries(METRIC))
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
			texts(await fs.readFile('/.agents/nutstore-sync/偏好/记忆 🧠.md')),
		).toEqual(['One 一 1️⃣', 'Two 二 2️⃣', 'Three 三 3️⃣'])
	})

	it('rejects a stale edit atomically and refreshes context after a user changes the file', async () => {
		const fs = new InMemoryFs()
		const memory = createRepository()
		await memory.edit(fs, { remember: [METRIC, REVIEW], forget: [] })
		const old = ids(`${METRIC}\n${REVIEW}\n`)
		const changed = `${METRIC}\nWeekly review on Mondays 每周一复盘 🗓️\n`
		await fs.writeFile(`/${memory.path}`, changed)
		await expect(
			memory.edit(fs, {
				forget: old,
				remember: ['Drafts in inbox 草稿收件箱 📥'],
			}),
		).rejects.toThrow('nothing was changed')
		expect(await fs.readFile(`/${memory.path}`)).toBe(changed)
		expect(memory.getEntries()).toEqual(listMemoryEntries(changed))
		await memory.edit(fs, { forget: [ids(changed)[1]], remember: [] })
		expect(await fs.readFile(`/${memory.path}`)).toBe(METRIC + '\n')
	})

	it('keeps independent queued deletions valid after earlier lines are removed', async () => {
		const fs = new InMemoryFs()
		const memory = createRepository()
		await memory.edit(fs, { remember: [METRIC, REVIEW], forget: [] })
		const original = ids(`${METRIC}\n${REVIEW}\n`)
		const results = await Promise.allSettled(
			original.map((id) => memory.edit(fs, { remember: [], forget: [id] })),
		)
		expect(results.map((result) => result.status)).toEqual([
			'fulfilled',
			'fulfilled',
		])
		expect(await fs.readFile(`/${memory.path}`)).toBe('')
		expect(memory.getEntries()).toEqual([])
	})

	it('preserves a UTF-8 BOM so disclosed references match bytes read for editing', async () => {
		const fs = new InMemoryFs()
		const memory = createRepository()
		const note = `\uFEFF${METRIC}\r\n${REVIEW}`
		await fs.writeFile(`/${memory.path}`, note)
		await memory.edit(fs, { remember: [], forget: [ids(note)[1]] })
		const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
			await fs.readFileBuffer(`/${memory.path}`),
		)
		expect(raw).toBe(`\uFEFF${METRIC}\r\n`)
		await memory.edit(fs, { remember: [], forget: ids(raw) })
		expect(memory.getEntries()).toEqual([])
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
			'Kept 保留 ✅\n',
		)
	})
})
