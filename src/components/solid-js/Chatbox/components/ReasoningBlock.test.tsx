// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createStore } from 'solid-js/store'
import { render } from 'solid-js/web'
import { ReasoningBlock } from './ReasoningBlock'

async function nextTask() {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('reasoning preview', () => {
	it('updates with streamed text and retains the complete content', async () => {
		const [part, setPart] = createStore({
			type: 'reasoning' as const,
			text: 'Compare 比较 🌿',
		})
		const container = document.createElement('div')
		const dispose = render(() => <ReasoningBlock part={part} />, container)

		const preview = container.querySelector('.chatbox-collapsible-preview')!
		expect(preview.textContent).toBe('Compare 比较 🌿')

		const details = container.querySelector<HTMLDetailsElement>(
			'details.chatbox-collapsible',
		)!
		details.open = true
		await nextTask()

		setPart('text', 'Compare 比较 🌿\nFinish 完成 👩‍💻')
		expect(preview.textContent).toBe('Compare 比较 🌿\nFinish 完成 👩‍💻')
		expect(container.querySelector('pre')?.textContent).toBe(
			'Compare 比较 🌿\nFinish 完成 👩‍💻',
		)
		dispose()
	})

	it('bounds the collapsed header while the body keeps the full text', async () => {
		const body = `${'Reviewing 审阅 🧭 '.repeat(40)}Conclusion 结论 👩‍💻`
		const container = document.createElement('div')
		const dispose = render(
			() => <ReasoningBlock part={{ type: 'reasoning', text: body }} />,
			container,
		)

		const preview = container.querySelector('.chatbox-collapsible-preview')!
		expect(preview.textContent!.length).toBeLessThanOrEqual(200)
		expect(preview.textContent!.endsWith('Conclusion 结论 👩‍💻')).toBe(true)

		const details = container.querySelector<HTMLDetailsElement>(
			'details.chatbox-collapsible',
		)!
		details.open = true
		await nextTask()

		expect(container.querySelector('pre')?.textContent).toBe(body)
		dispose()
	})
})
