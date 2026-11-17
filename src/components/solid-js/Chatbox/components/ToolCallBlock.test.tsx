// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from 'solid-js/web'
import type { ChatDisplayToolCallBlock } from '~/ai/chat/types'
import { ToolCallBlock } from './ToolCallBlock'

async function nextTask() {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('tool call details', () => {
	it('keeps parameters collapsed by default and shows the result', async () => {
		const block = {
			kind: 'tool-call',
			toolCall: {
				type: 'dynamic-tool',
				toolCallId: 'bash-neutral',
				toolName: 'bash',
				state: 'output-available',
				input: {
					purpose: 'List notes 查看目录 🌿',
					script: 'ls notes',
					cwd: '/notes',
				},
				output: 'alpha.md\nbeta.md',
			},
			timing: { startedAt: 0, finishedAt: 635 },
		} as unknown as ChatDisplayToolCallBlock
		const container = document.createElement('div')
		const dispose = render(
			() => <ToolCallBlock block={block} now={635} />,
			container,
		)

		expect(container.textContent).not.toContain('ls notes')
		const details = container.querySelector<HTMLDetailsElement>(
			'details.chatbox-collapsible',
		)!
		details.open = true
		await nextTask()
		await nextTask()

		expect(container.textContent).toContain('alpha.md\nbeta.md')
		expect(container.textContent).not.toContain('"script": "ls notes"')
		expect(
			container.querySelector('.ns-chatbox-markdown--details'),
		).not.toBeNull()

		const params = container.querySelectorAll<HTMLDetailsElement>(
			'details.chatbox-collapsible',
		)[1]
		expect(params).toBeDefined()
		params.open = true
		await nextTask()
		await nextTask()

		expect(container.textContent).toContain('"script": "ls notes"')
		dispose()
	})
})
