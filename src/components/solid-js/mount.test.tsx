// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { For, Show } from 'solid-js'
import { createMount } from './mount'

interface ViewProps {
	items: Array<{ id: string; text: string }>
	optional?: string
}

function View(props: ViewProps) {
	return (
		<div>
			<Show when={props.optional}>
				{(value) => <span data-optional>{value()}</span>}
			</Show>
			<ul>
				<For each={props.items}>
					{(item) => <li data-id={item.id}>{item.text}</li>}
				</For>
			</ul>
		</div>
	)
}

describe('createMount replace mode', () => {
	it('keeps a row when the array is new but the item is unchanged', () => {
		const container = document.createElement('div')
		const item = { id: 'one', text: 'Neutral 中性 🌿' }
		const controller = createMount(
			View,
			container,
			{ items: [item] },
			{ updateMode: 'replace' },
		)
		const row = container.querySelector('[data-id="one"]')

		controller.update({ items: [item] })

		expect(container.querySelector('[data-id="one"]')).toBe(row)
		controller.destroy()
	})

	it('deletes an optional prop that disappears', () => {
		const container = document.createElement('div')
		const controller = createMount(
			View,
			container,
			{ items: [], optional: 'shown 显示 🚀' },
			{ updateMode: 'replace' },
		)
		expect(container.querySelector('[data-optional]')?.textContent).toBe(
			'shown 显示 🚀',
		)

		controller.update({ items: [] })

		expect(container.querySelector('[data-optional]')).toBeNull()
		controller.destroy()
	})
})
