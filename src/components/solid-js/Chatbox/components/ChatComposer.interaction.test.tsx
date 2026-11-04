// @vitest-environment jsdom

import { startCompletion, selectedCompletion } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer } from './ChatComposer'

vi.mock('obsidian', () => ({ setIcon: vi.fn() }))

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

function pressEnter(element: HTMLElement) {
	const event = new KeyboardEvent('keydown', {
		key: 'Enter',
		bubbles: true,
		cancelable: true,
	})
	Object.defineProperty(event, 'keyCode', { value: 13 })
	element.dispatchEvent(event)
	return event
}

describe('composer keyboard interaction', () => {
	let host: HTMLDivElement
	let dispose: (() => void) | undefined

	beforeEach(() => {
		vi.stubGlobal('ResizeObserver', TestResizeObserver)
		Range.prototype.getClientRects = () => [] as unknown as DOMRectList
		Range.prototype.getBoundingClientRect = () => new DOMRect()
		const createSpan = () => document.createElement('span')
		Object.assign(document, { win: window, createSpan })
		Object.assign(window, { createSpan })
		host = document.createElement('div')
		document.body.appendChild(host)
	})

	afterEach(() => {
		dispose?.()
		dispose = undefined
		host.remove()
		vi.unstubAllGlobals()
	})

	async function waitForCompletion() {
		await new Promise((resolve) => setTimeout(resolve, 100))
		await new Promise((resolve) =>
			window.requestAnimationFrame(() => resolve(undefined)),
		)
	}

	function mountComposer(
		onSubmit: () => void,
		onCommand: () => void,
		mentionPaths: () => string[] = () => [],
	) {
		dispose = render(
			() => (
				<ChatComposer
					ref={() => {}}
					value=""
					sessionId="neutral-session"
					placeholder="Message 消息"
					height={undefined}
					onChange={() => {}}
					onSubmit={onSubmit}
					mentionPaths={mentionPaths}
					onMention={() => {}}
					commands={() => [
						{
							name: 'file',
							label: '选择文件 Select file 📎',
							run: onCommand,
						},
					]}
					onPasteImages={() => {}}
				/>
			),
			host,
		)
		const editor = EditorView.findFromDOM(
			host.querySelector<HTMLElement>('.cm-editor')!,
		)
		if (!editor) throw new Error('Composer editor did not mount')
		return editor
	}

	it('confirms the selected command with Enter without submitting the message', async () => {
		const onSubmit = vi.fn()
		const onCommand = vi.fn()
		const editor = mountComposer(onSubmit, onCommand)
		editor.dispatch({
			changes: { from: 0, insert: '/选择' },
			selection: { anchor: 3 },
		})
		startCompletion(editor)
		await waitForCompletion()

		expect(selectedCompletion(editor.state)?.label).toBe('/file')
		const layer = host.querySelector<HTMLElement>('.ns-completion-layer')!
		const popup = layer.querySelector<HTMLElement>(
			'.cm-tooltip.ns-composer-completions',
		)!
		expect(popup.parentElement?.parentElement).toBe(layer)
		const event = pressEnter(editor.contentDOM)

		expect(event.defaultPrevented).toBe(true)
		expect(editor.state.doc.toString()).toBe('')
		expect(onCommand).toHaveBeenCalledOnce()
		expect(onSubmit).not.toHaveBeenCalled()
	})

	it('renders a note path below its file name', async () => {
		const editor = mountComposer(vi.fn(), vi.fn(), () => [
			'Notes/普通笔记 🌱.md',
		])
		const query = '@🌱'
		editor.dispatch({
			changes: { from: 0, insert: query },
			selection: { anchor: query.length },
		})
		startCompletion(editor)
		await waitForCompletion()

		const option = host.querySelector<HTMLElement>(
			'li.ns-completion-file-option',
		)!
		const row = option.querySelector<HTMLElement>('.ns-completion-file')!
		expect(row).not.toBeNull()
		expect(
			row.querySelector<HTMLElement>('.ns-completion-name')?.textContent,
		).toBe('普通笔记 🌱.md')
		expect(
			row.querySelector<HTMLElement>('.ns-completion-description')?.textContent,
		).toBe('Notes')
	})

	it('submits Enter normally when no completion is open', () => {
		const onSubmit = vi.fn()
		const editor = mountComposer(onSubmit, vi.fn())
		const message = 'Neutral message 普通消息 🌱'
		editor.dispatch({
			changes: { from: 0, insert: message },
			selection: { anchor: message.length },
		})

		pressEnter(editor.contentDOM)

		expect(onSubmit).toHaveBeenCalledOnce()
	})
})
