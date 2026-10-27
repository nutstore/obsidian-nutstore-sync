import { cloneDeep, debounce, isEqual, throttle } from 'es-toolkit/compat'
import { afterEach, describe, expect, it, vi } from 'vitest'

const labels = ['Neutral entry', '中性条目', 'Entry 条目 🌱']
afterEach(() => vi.useRealTimers())

describe('collection helpers used by settings and sync', () => {
	it.each(labels)('isolates editable settings snapshots: %s', (label) => {
		const original = {
			rules: [{ expr: label, options: { caseSensitive: false } }],
		}
		const edited = cloneDeep(original)
		expect(isEqual(edited, original)).toBe(true)
		edited.rules[0].options.caseSensitive = true
		expect(original.rules[0].options.caseSensitive).toBe(false)
		expect(isEqual(edited, original)).toBe(false)
	})

	it('saves only the latest edit and supports flush and cancellation', () => {
		vi.useFakeTimers()
		const save = vi.fn()
		const scheduleSave = debounce(save, 100)
		for (const label of labels) scheduleSave(label)
		expect(save).not.toHaveBeenCalled()
		vi.advanceTimersByTime(100)
		expect(save.mock.calls).toEqual([[labels[2]]])
		scheduleSave(labels[0])
		scheduleSave.flush()
		expect(save).toHaveBeenLastCalledWith(labels[0])
		scheduleSave(labels[1])
		scheduleSave.cancel()
		vi.advanceTimersByTime(100)
		expect(save).toHaveBeenCalledTimes(2)
	})

	it('renders progress immediately and retains the latest trailing update', () => {
		vi.useFakeTimers()
		const render = vi.fn()
		const update = throttle(render, 200)
		for (const label of labels) update(label)
		expect(render.mock.calls).toEqual([[labels[0]]])
		vi.advanceTimersByTime(200)
		expect(render.mock.calls).toEqual([[labels[0]], [labels[2]]])
	})
})
