import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import { composerCompletions, composerTrigger } from './composer-completions'

const paths = [
	'Notes/Neutral note.md',
	'笔记/普通笔记 🌱.md',
	'Archive/Neutral note.md',
]
function complete(text: string) {
	return composerCompletions({
		paths: () => paths,
		mention: vi.fn(),
		commands: () => [
			{
				name: 'file',
				label: '选择文件 Select file 📎',
				description: '添加文本或图片 Attach text or images 🖼️',
				run: vi.fn(),
			},
		],
	})(
		new CompletionContext(
			EditorState.create({ doc: text }),
			text.length,
			false,
		),
	)
}
describe('composer completions', () => {
	it.each(['@Neutral note', '@普通笔记', '@🌱'])(
		'finds paths for %s',
		(text) => {
			expect(complete(text)?.options.length).toBeGreaterThan(0)
		},
	)
	it('keeps full paths to distinguish duplicate names', () => {
		expect(
			complete('@Neutral note')?.options.map((option) => option.label),
		).toEqual(['Archive/Neutral note.md', 'Notes/Neutral note.md'])
	})
	it.each([
		'neutral@example.test',
		'Notes/file',
		'Explain /file',
		'普通文本 🌱',
	])('keeps %s as ordinary text', (text) => {
		expect(composerTrigger(text)).toBeNull()
	})
	it.each(['/fi', '/选择', '/📎'])(
		'matches commands by name and localized label: %s',
		(text) => {
			expect(complete(text)?.options[0].label).toBe('/file')
		},
	)
	it('separates the file name from its directory without changing the reference', () => {
		expect(complete('@普通笔记')?.options[0]).toMatchObject({
			label: '笔记/普通笔记 🌱.md',
			displayLabel: '普通笔记 🌱.md',
			detail: '笔记',
		})
	})
	it('provides an explanatory command description and a file icon type', () => {
		expect(complete('/file')?.options[0]).toMatchObject({
			type: 'command',
			detail: '添加文本或图片 Attach text or images 🖼️',
		})
		expect(complete('@普通笔记')?.options[0].type).toBe('file')
	})
	it('does not offer unrelated entries', () => {
		expect(complete('@不存在 🧭')?.options).toEqual([])
	})
})
