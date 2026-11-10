// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { FileChangesBlock } from './FileChangesBlock'

const { buildFileDiff } = vi.hoisted(() => ({
	buildFileDiff: vi.fn(async () => ({
		vaultPath: 'notes/neutral.md',
		operation: 'update' as const,
		hunks: [],
	})),
}))

vi.mock('~/ai/chat/messages/file-diff', () => ({ buildFileDiff }))

async function nextTask() {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('file changes block', () => {
	it('defers diffing until the change is expanded', async () => {
		const container = document.createElement('div')
		const dispose = render(
			() => (
				<FileChangesBlock
					changes={[
						{
							vaultPath: 'notes/neutral.md',
							operation: 'update',
							before: { kind: 'file', contentBase64: 'YQ==' },
							after: { kind: 'file', contentBase64: 'Yg==' },
						},
					]}
				/>
			),
			container,
		)

		expect(buildFileDiff).not.toHaveBeenCalled()
		const details = container.querySelector<HTMLDetailsElement>(
			'details.chatbox-collapsible',
		)
		if (!details) throw new Error('Expected a collapsible change')
		details.open = true
		await nextTask()
		await nextTask()
		expect(buildFileDiff).toHaveBeenCalledTimes(1)
		dispose()
	})
})
