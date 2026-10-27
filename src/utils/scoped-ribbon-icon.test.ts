// @vitest-environment jsdom
/* eslint-disable obsidianmd/prefer-create-el -- Simulate the native ribbon without loading Obsidian DOM extensions. */
import { describe, expect, it } from 'vitest'
import type { Plugin } from 'obsidian'
import { createScopedRibbonIcon } from './scoped-ribbon-icon'

describe('native ribbon registration ownership', () => {
	it('unregisters actions before host redraw and isolates Apps with identical multilingual titles', () => {
		const registry = new Map<string, HTMLElement>()
		const unload: Array<() => void> = []
		const plugin = {
			manifest: { id: 'neutral-plugin' },
			register: (cleanup: () => void) => {
				unload.push(cleanup)
			},
			addRibbonIcon(this: Plugin, _icon: string, title: string) {
				const id = `${this.manifest.id}:${title}`
				const el = document.createElement('button')
				el.title = title
				registry.set(id, el)
				document.body.append(el)
				this.register(() => {
					registry.delete(id)
					el.remove()
				})
				return el
			},
		} as unknown as Plugin
		const originalRegister = plugin.register
		const title = '中性工具 Neutral tool 🌿'
		const first = createScopedRibbonIcon(
			plugin,
			'circle',
			title,
			() => {},
			'app-first',
		)
		const second = createScopedRibbonIcon(
			plugin,
			'circle',
			title,
			() => {},
			'app-second',
		)
		expect(registry.size).toBe(2)
		expect(plugin.register).toBe(originalRegister)
		expect(plugin.manifest.id).toBe('neutral-plugin')
		first.dispose()
		first.dispose()
		for (const el of registry.values()) document.body.append(el)
		expect(first.element.isConnected).toBe(false)
		expect(second.element.isConnected).toBe(true)
		expect(registry.size).toBe(1)
		for (const cleanup of unload) cleanup()
		expect(registry.size).toBe(0)
		expect(second.element.isConnected).toBe(false)
		second.dispose()
	})
})
/* eslint-enable obsidianmd/prefer-create-el -- Native DOM fixture setup is complete. */
