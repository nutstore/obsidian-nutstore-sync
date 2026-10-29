import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

// Drafts use UTF-16 positions, including emoji and combining characters.
describe('composer text history', () => {
	it.each(['A neutral note', '一条普通笔记', '观察 🌱 café e\u0301'])(
		'restores %s without encoding loss',
		(text) => {
			let state = EditorState.create({ doc: text, extensions: [history()] })
			state = state.update({
				changes: { from: state.doc.length, insert: '\nNext 下一步 🧭' },
			}).state
			expect(state.doc.toString()).toBe(`${text}\nNext 下一步 🧭`)
			expect(
				undo({
					state,
					dispatch: (transaction) => {
						state = transaction.state
					},
				}),
			).toBe(true)
			expect(state.doc.toString()).toBe(text)
			state = EditorState.create({
				doc: 'Another note 另一条笔记 🌿',
				extensions: [history()],
			})
			expect(
				undo({
					state,
					dispatch: (transaction) => {
						state = transaction.state
					},
				}),
			).toBe(false)
		},
	)
})
