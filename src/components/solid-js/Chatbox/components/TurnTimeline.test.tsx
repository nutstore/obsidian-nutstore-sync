// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { For } from 'solid-js'
import { render } from 'solid-js/web'
import { createStore, reconcile } from 'solid-js/store'
import type { ChatDisplayBlock, ChatRunState } from '~/ai/chat/types'
import type { ChatTimelineMessageItem } from '~/ai/chat/ui/types'
import { TurnTimeline } from './TurnTimeline'

const content = (text: string): ChatDisplayBlock => ({
	kind: 'content',
	parts: [{ type: 'text', text }],
})
const item = (
	id: string,
	role: ChatTimelineMessageItem['message']['role'],
	displayBlocks: ChatDisplayBlock[],
): ChatTimelineMessageItem => ({
	message: { id, role, parts: [] },
	displayBlocks,
	createdAt: 0,
	showHeader: true,
})

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function mountTimeline(timeline: ChatTimelineMessageItem[]) {
	const [state, setState] = createStore<{
		timeline: ChatTimelineMessageItem[]
		runState: ChatRunState
	}>({ timeline, runState: 'thinking' })
	const container = (<div />) as HTMLDivElement
	document.body.append(container)
	const dispose = render(
		() => (
			<TurnTimeline
				timeline={state.timeline}
				sessionId="session"
				runState={state.runState}
			>
				{(row) => (
					<details data-message={row().item.message.id}>
						<summary>{row().item.message.id}</summary>
						<For each={row().blocks}>
							{(block) => (
								<p>
									{block.kind === 'content'
										? block.parts
												.map((part) => (part.type === 'text' ? part.text : ''))
												.join('')
										: block.kind}
								</p>
							)}
						</For>
					</details>
				)}
			</TurnTimeline>
		),
		container,
	)
	cleanups.push(() => {
		dispose()
		container.remove()
	})
	return {
		container,
		setState,
		message: (id: string) =>
			container.querySelector<HTMLDetailsElement>(`[data-message="${id}"]`)!,
	}
}

describe('turn timeline', () => {
	it('keeps process content expanded while tools arrive and execution ends', () => {
		const input = [
			item('user', 'user', [content('Compare 比较 🌿')]),
			item('work', 'assistant', [
				{
					kind: 'reasoning',
					part: { type: 'reasoning', text: 'Inspect 检查 🌿' },
				},
			]),
		]
		const view = mountTimeline(input)
		view.message('work').open = true
		view.setState('timeline', 1, 'displayBlocks', 1, {
			kind: 'tool-call',
			toolCall: {
				type: 'dynamic-tool',
				toolName: 'read',
				toolCallId: 'read-example',
				state: 'input-available',
				input: { purpose: 'Read 示例 🌿' },
			},
		})
		expect(view.message('work').open).toBe(true)
		expect(view.message('work').textContent).toContain('tool-call')
		view.setState(
			'timeline',
			2,
			item('reply', 'assistant', [content('Result 结果 🌿')]),
		)
		expect(view.message('work').open).toBe(true)
		expect(view.message('reply').textContent).toContain('Result 结果 🌿')
		view.setState('runState', 'idle')
		expect(view.message('work').open).toBe(true)
	})
	it('preserves an expanded reply when execution ends and later messages arrive', () => {
		const input = [
			item('user', 'user', [content('Compare 比较 🌿')]),
			item('reply', 'assistant', [content('Result 结果 🌿')]),
		]
		const view = mountTimeline(input)
		view.message('reply').open = true
		view.setState('runState', 'idle')
		expect(view.message('reply').open).toBe(true)
		view.setState(
			'timeline',
			reconcile([
				...input,
				item('next', 'user', [content('Continue 继续 🌿')]),
			]),
		)
		expect(view.message('reply').open).toBe(true)
		expect(view.message('next').textContent).toContain('Continue 继续 🌿')
	})
})
