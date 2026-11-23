import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { applyHunks, applyPatchTool, parsePatch } from '~/ai/tools/apply-patch'
import { createFragmentReadTracker } from '~/ai/tools/file-operation'
import { MemoryVault } from '../harness/memory-vault'
import { simParams } from '../harness/sim-config'

function createTestReadTracker(readPaths: string[] = []) {
	return createFragmentReadTracker({
		readVaultPaths: [...readPaths],
	})
}

const LINE_POOL = [
	'alpha',
	'beta',
	'gamma',
	'中文行一',
	'中性条目 🌱',
	'复合表情 👨‍👩‍👧‍👦 校验',
	'## Section 章节',
	'- bullet item',
	'const x = 1 + 2',
	'',
]

function buildUniqueLines(count: number, seedPrefix: string): string[] {
	return Array.from(
		{ length: count },
		(_, index) =>
			`${seedPrefix}-${index}: ${LINE_POOL[index % LINE_POOL.length]}`,
	)
}

function buildUpdatePatch(
	path: string,
	beforeLines: readonly string[],
	start: number,
	deleteCount: number,
	insertedLines: readonly string[],
): string {
	const ctxBeforeStart = Math.max(0, start - 2)
	const ctxAfterEnd = Math.min(beforeLines.length, start + deleteCount + 2)
	const hunkLines: string[] = []
	for (let i = ctxBeforeStart; i < start; i += 1) {
		hunkLines.push(` ${beforeLines[i]}`)
	}
	for (let i = start; i < start + deleteCount; i += 1) {
		hunkLines.push(`-${beforeLines[i]}`)
	}
	for (const line of insertedLines) {
		hunkLines.push(`+${line}`)
	}
	for (let i = start + deleteCount; i < ctxAfterEnd; i += 1) {
		hunkLines.push(` ${beforeLines[i]}`)
	}
	return [
		'*** Begin Patch',
		`*** Update File: ${path}`,
		'@@',
		...hunkLines,
		'*** End Patch',
	].join('\n')
}

describe('apply-patch property-based & adversarial fuzzing', () => {
	it('round-trips arbitrary valid patches byte-exactly across LF/CRLF, EOF newline, CJK, and Emoji', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 18 }),
				fc.nat(100),
				fc.nat(5),
				fc.array(fc.constantFrom(...LINE_POOL), { minLength: 0, maxLength: 5 }),
				fc.constantFrom('\n', '\r\n'),
				fc.boolean(),
				(lineCount, rawStart, rawDelCount, inserted, eol, finalNewline) => {
					const beforeLines = buildUniqueLines(lineCount, 'L')
					const start = rawStart % lineCount
					const deleteCount = Math.min(rawDelCount, lineCount - start)
					// Skip no-op empty hunk when nothing is deleted and nothing inserted and no context
					fc.pre(deleteCount > 0 || inserted.length > 0)

					const before = beforeLines.join(eol) + (finalNewline ? eol : '')
					const expectedEol = before.includes('\r\n') ? '\r\n' : '\n'
					const expectedLines = [
						...beforeLines.slice(0, start),
						...inserted,
						...beforeLines.slice(start + deleteCount),
					]
					const expected =
						expectedLines.length === 0
							? ''
							: expectedLines.join(expectedEol) +
								(finalNewline ? expectedEol : '')

					const patchText = buildUpdatePatch(
						'notes/补丁验证🌱.md',
						beforeLines,
						start,
						deleteCount,
						inserted,
					)
					const operations = parsePatch(patchText)
					expect(operations).toHaveLength(1)
					expect(operations[0].kind).toBe('update')
					if (operations[0].kind === 'update') {
						const actual = applyHunks(
							before,
							operations[0].hunks,
							operations[0].path,
						)
						expect(actual).toBe(expected)
					}
				},
			),
			simParams(80, 201),
		)
	})

	it('rejects malformed, truncated, and ambiguous patches without corrupting existing files', async () => {
		const malformedPatches = [
			'',
			'not a patch',
			'*** Begin Patch\n*** End Patch',
			'*** Begin Patch\n*** Add File: a.md\nmissing-plus\n*** End Patch',
			'*** Begin Patch\n*** Update File: note.md\n@@\n*** End Patch',
			'*** Begin Patch\n*** Update File: note.md\n@@\n!bad-prefix\n*** End Patch',
			'*** Begin Patch\n*** Update File: note.md\n*** End Patch',
			'*** Begin Patch\n*** Update File: note.md\n@@\n-nonexistent line\n+replacement\n*** End Patch',
			// Truncated (missing End Patch)
			'*** Begin Patch\n*** Update File: note.md\n@@\n-dup\n+changed',
			// Ambiguous context (matches twice)
			'*** Begin Patch\n*** Update File: note.md\n@@\n-dup\n+changed\n*** End Patch',
		]

		const vault = new MemoryVault()
		const original = 'dup\nmiddle\ndup\n'
		vault.seedFile('note.md', original)
		const readTracker = createTestReadTracker(['note.md'])

		for (const badPatch of malformedPatches) {
			await expect(
				applyPatchTool.execute!(
					{ purpose: 'Test malformed patch rejection', patch: badPatch },
					{
						toolCallId: 'fuzz-bad',
						messages: [],
						context: {
							app: vault.app as never,
							readTracker,
						},
					},
				),
			).rejects.toThrow()
			expect(vault.readTextDirect('note.md')).toBe(original)
		}
	})

	it('blocks path traversal and illegal characters before touching the vault', async () => {
		const maliciousPaths = [
			'../escape.md',
			'../../etc/passwd',
			'notes/../../escape.md',
			'notes/bad\u0000name.md',
			'notes\\windows\\escape.md',
			'.',
			'..',
		]

		const vault = new MemoryVault()
		vault.seedFile('safe/笔记🌱.md', 'untouched\n')
		vault.clearMutations()

		for (const maliciousPath of maliciousPaths) {
			const patch = [
				'*** Begin Patch',
				`*** Add File: ${maliciousPath}`,
				'+pwned',
				'*** End Patch',
			].join('\n')

			await expect(
				applyPatchTool.execute!(
					{ purpose: 'Reject path traversal', patch },
					{
						toolCallId: 'fuzz-traversal',
						messages: [],
						context: {
							app: vault.app as never,
							readTracker: createTestReadTracker(),
						},
					},
				),
			).rejects.toThrow()
		}

		expect(vault.mutations).toHaveLength(0)
		expect(vault.readTextDirect('safe/笔记🌱.md')).toBe('untouched\n')
	})

	it('atomically validates multi-file patches so a late failure never partially writes earlier files', async () => {
		const vault = new MemoryVault()
		vault.seedFile('a.md', 'line-a\n')
		vault.seedFile('b.md', 'line-b\n')
		const readTracker = createTestReadTracker(['a.md', 'b.md'])
		vault.clearMutations()

		const patch = [
			'*** Begin Patch',
			'*** Add File: created-early.md',
			'+should never land',
			'*** Update File: a.md',
			'@@',
			'-line-a',
			'+line-a-modified',
			'*** Update File: b.md',
			'@@',
			'-missing-context',
			'+broken',
			'*** End Patch',
		].join('\n')

		await expect(
			applyPatchTool.execute!(
				{ purpose: 'Verify atomic planning before writes', patch },
				{
					toolCallId: 'fuzz-atomic',
					messages: [],
					context: {
						app: vault.app as never,
						readTracker,
					},
				},
			),
		).rejects.toThrow()

		expect(vault.mutations).toHaveLength(0)
		expect(vault.readTextDirect('created-early.md')).toBeUndefined()
		expect(vault.readTextDirect('a.md')).toBe('line-a\n')
		expect(vault.readTextDirect('b.md')).toBe('line-b\n')
	})
})
