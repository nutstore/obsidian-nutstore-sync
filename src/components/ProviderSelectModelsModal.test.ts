// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createModelConfig } from '~/ai/catalog/config'
import type NutstorePlugin from '..'
import ProviderSelectModelsModal from './ProviderSelectModelsModal'

vi.mock('obsidian', () => {
	/* eslint-disable obsidianmd/prefer-create-el -- Implement host DOM helpers that are unavailable in jsdom. */
	function element(
		tag = 'div',
		options: {
			cls?: string
			text?: string
			type?: string
			attr?: Record<string, string>
		} = {},
	) {
		const el = document.createElement(tag)
		if (options.cls) el.className = options.cls
		if (options.text) el.textContent = options.text
		if (options.type && 'type' in el)
			(el as HTMLInputElement).type = options.type
		Object.entries(options.attr ?? {}).forEach(([key, value]) =>
			el.setAttribute(key, value),
		)
		return Object.assign(el, {
			createEl: (t: string, opts?: typeof options) =>
				el.appendChild(element(t, opts)),
			createDiv: (opts?: typeof options) =>
				el.appendChild(element('div', opts)),
			createSpan: (opts?: typeof options) =>
				el.appendChild(element('span', opts)),
			empty: () => el.replaceChildren(),
			addClass: (cls: string) => el.classList.add(...cls.split(/\s+/)),
			removeClass: (cls: string) => el.classList.remove(...cls.split(/\s+/)),
		})
	}
	/* eslint-enable obsidianmd/prefer-create-el -- End of DOM helper mock */

	class MockModal {
		modalEl = element('div', { cls: 'modal' })
		contentEl = this.modalEl.createDiv({ cls: 'modal-content' })
		app = {}
		open() {
			this.onOpen()
		}
		close() {
			this.onClose()
		}
		onOpen() {}
		onClose() {}
	}

	class MockNotice {}

	return {
		Modal: MockModal,
		Notice: MockNotice,
		Setting: class {},
		setIcon: () => {},
	}
})

vi.mock('~/i18n', () => ({
	default: {
		t: (key: string) => key,
	},
}))

describe('ProviderSelectModelsModal', () => {
	const mockPlugin = {
		app: {},
		ai: {
			lifecycle: {
				scope: {
					ownModal: vi.fn(),
				},
			},
		},
	} as unknown as NutstorePlugin

	const testModels = [
		{
			id: 'ns/google/gemini-4-argon',
			name: 'Gemini 4 Argon',
			modelConfig: createModelConfig({
				id: 'ns/google/gemini-4-argon',
				name: 'Gemini 4 Argon',
			}),
		},
		{
			id: 'ns/anthropic/claude-haiku-5.5',
			name: 'Claude Haiku 5.5',
			modelConfig: createModelConfig({
				id: 'ns/anthropic/claude-haiku-5.5',
				name: 'Claude Haiku 5.5',
			}),
		},
		{
			id: 'ns/开源模型/🚀-deepseek-flash',
			name: '深度求索 🚀',
			modelConfig: createModelConfig({
				id: 'ns/开源模型/🚀-deepseek-flash',
				name: '深度求索 🚀',
			}),
		},
	]

	it('renders modal content and elements properly', () => {
		const onAdd = vi.fn()
		const modal = new ProviderSelectModelsModal(mockPlugin, testModels, onAdd)
		modal.open()

		const title = modal.contentEl.querySelector('h2')
		expect(title?.textContent).toBe('settings.ai.models.selectModelsTitle')

		const searchInput = modal.contentEl.querySelector(
			'input[type="text"]',
		) as HTMLInputElement
		expect(searchInput).toBeTruthy()

		const checkboxes = modal.contentEl.querySelectorAll(
			'input[type="checkbox"]',
		)
		expect(checkboxes.length).toBe(3)
	})

	it('supports filtering by fuzzy subsequence search query (e.g. ggle -> google) with Chinese and emoji', () => {
		const onAdd = vi.fn()
		const modal = new ProviderSelectModelsModal(mockPlugin, testModels, onAdd)
		modal.open()

		const searchInput = modal.contentEl.querySelector(
			'input[type="text"]',
		) as HTMLInputElement

		// Fuzzy subsequence search: ggle matches google
		searchInput.value = 'ggle'
		searchInput.dispatchEvent(new Event('input'))
		let checkboxes = modal.contentEl.querySelectorAll('input[type="checkbox"]')
		expect(checkboxes.length).toBe(1)

		// Filter for Chinese / emoji model with subsequence
		searchInput.value = '深索'
		searchInput.dispatchEvent(new Event('input'))
		checkboxes = modal.contentEl.querySelectorAll('input[type="checkbox"]')
		expect(checkboxes.length).toBe(1)
	})

	it('supports toggle select all and adds selected models on submit', () => {
		const onAdd = vi.fn()
		const modal = new ProviderSelectModelsModal(mockPlugin, testModels, onAdd)
		modal.open()

		const buttons = modal.contentEl.querySelectorAll('button')
		const selectAllBtn = buttons[0]
		expect(selectAllBtn.textContent).toBe('settings.ai.models.selectAll')

		// Click select all
		selectAllBtn.click()
		expect(selectAllBtn.textContent).toBe('settings.ai.models.deselectAll')

		// Click add selected button (last button)
		const addBtn = buttons[buttons.length - 1]
		addBtn.click()

		const expectedModels = [...testModels].sort((a, b) =>
			a.id.localeCompare(b.id, undefined, { numeric: true }),
		)
		expect(onAdd).toHaveBeenCalledWith(expectedModels)
	})
})
