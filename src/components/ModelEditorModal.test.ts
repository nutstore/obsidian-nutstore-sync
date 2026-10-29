// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createModelConfig } from '~/ai/catalog/config'
import type NutstorePlugin from '..'
import ModelEditorModal from './ModelEditorModal'

vi.mock('obsidian', () => {
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

	class MockSetting {
		settingEl = element('div', { cls: 'setting-item' })
		controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' })
		constructor(containerEl: HTMLElement) {
			containerEl.appendChild(this.settingEl)
		}
		setName(_name: string) {
			return this
		}
		setDesc(_desc: string) {
			return this
		}
		then(cb: (setting: this) => any) {
			cb(this)
			return this
		}
		addText(
			cb: (text: {
				setValue: (val: string) => typeof text
				setPlaceholder: (val: string) => typeof text
				onChange: (cb: (val: string) => void) => typeof text
				inputEl: HTMLInputElement
			}) => void,
		) {
			const inputEl = document.createElement('input')
			this.controlEl.appendChild(inputEl)
			let changeHandler: ((val: string) => void) | undefined
			inputEl.addEventListener('input', () => changeHandler?.(inputEl.value))
			const textComp = {
				setValue: (val: string) => {
					inputEl.value = val
					return textComp
				},
				setPlaceholder: (val: string) => {
					inputEl.placeholder = val
					return textComp
				},
				onChange: (handler: (val: string) => void) => {
					changeHandler = handler
					return textComp
				},
				inputEl,
			}
			cb(textComp)
			return this
		}
		addButton(
			cb: (btn: {
				setButtonText: (val: string) => typeof btn
				setCta: () => typeof btn
				onClick: (cb: () => void) => typeof btn
				buttonEl: HTMLButtonElement
			}) => void,
		) {
			const buttonEl = document.createElement('button')
			this.controlEl.appendChild(buttonEl)
			const btnComp = {
				setButtonText: (val: string) => {
					buttonEl.textContent = val
					return btnComp
				},
				setCta: () => btnComp,
				onClick: (handler: () => void) => {
					buttonEl.addEventListener('click', handler)
					return btnComp
				},
				buttonEl,
			}
			cb(btnComp)
			return this
		}
	}

	return {
		Modal: MockModal,
		Notice: MockNotice,
		Setting: MockSetting,
		Platform: { isWin: false, isMacOS: true, isLinux: false },
	}
})

vi.mock('~/i18n', () => ({
	default: {
		t: (key: string) => key,
	},
}))

describe('ModelEditorModal', () => {
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

	it('renders inputs and converts 1M and 65k shorthand to pure numbers on save', async () => {
		const initialModel = createModelConfig({
			id: 'custom-model',
			name: 'Custom Model',
			limit: { context: 128000, output: 4096 },
		})

		let savedModel = initialModel
		const onSave = vi.fn().mockImplementation((model) => {
			savedModel = model
			return true
		})

		const modal = new ModelEditorModal(mockPlugin, initialModel, onSave, false)
		modal.open()

		const textInputs = modal.contentEl.querySelectorAll('input')
		// [0] = id, [1] = contextLimit, [2] = outputLimit
		expect(textInputs.length).toBe(3)
		expect(textInputs[1].value).toBe('128,000')
		expect(textInputs[2].value).toBe('4,096')

		// Change context limit to shorthand 1M
		textInputs[1].value = '1M'
		textInputs[1].dispatchEvent(new Event('input'))

		// Change output limit to shorthand 65k
		textInputs[2].value = '65k'
		textInputs[2].dispatchEvent(new Event('input'))

		// Click Save button
		const buttons = modal.contentEl.querySelectorAll('button')
		const saveButton = buttons[buttons.length - 2]
		saveButton.click()

		expect(onSave).toHaveBeenCalled()
		expect(savedModel.limit.context).toBe(1000000)
		expect(savedModel.limit.output).toBe(65000)
	})

	it('rejects save when context limit format is invalid', async () => {
		const initialModel = createModelConfig({
			id: 'custom-model',
			name: 'Custom Model',
		})

		const onSave = vi.fn()
		const modal = new ModelEditorModal(mockPlugin, initialModel, onSave, false)
		modal.open()

		const textInputs = modal.contentEl.querySelectorAll('input')
		textInputs[1].value = 'invalid-number'
		textInputs[1].dispatchEvent(new Event('input'))

		const buttons = modal.contentEl.querySelectorAll('button')
		const saveButton = buttons[buttons.length - 2]
		saveButton.click()

		expect(onSave).not.toHaveBeenCalled()
	})

	it('preserves key insertion order when updating a model in provider models dictionary', () => {
		const models: Record<string, ReturnType<typeof createModelConfig>> = {
			'model-1': createModelConfig({ id: 'model-1' }),
			'model-2': createModelConfig({ id: 'model-2' }),
			'model-3': createModelConfig({ id: 'model-3' }),
		}

		const updatedModel = createModelConfig({
			id: 'model-2',
			name: 'Updated Model',
		})
		const nextModels: Record<string, ReturnType<typeof createModelConfig>> = {}
		for (const [key, val] of Object.entries(models)) {
			if (key === 'model-2') {
				nextModels[updatedModel.id] = updatedModel
			} else {
				nextModels[key] = val
			}
		}

		expect(Object.keys(nextModels)).toEqual(['model-1', 'model-2', 'model-3'])
		expect(nextModels['model-2'].name).toBe('Updated Model')
	})
})
