import i18n from '~/i18n'

const HTML_LANGUAGE_CLASS = 'language-html'

export function isRunnableHtmlCodeBlock(className: string): boolean {
	return className.split(/\s+/).includes(HTML_LANGUAGE_CLASS)
}

function toggleLabel(previewing: boolean): string {
	return i18n.t(
		previewing
			? 'chatbox.ui.actions.showHtmlCode'
			: 'chatbox.ui.actions.runHtmlCode',
	)
}

export function enhanceHtmlCodeBlocks(container: HTMLElement): void {
	const doc = container.ownerDocument

	for (const code of Array.from(container.querySelectorAll('pre > code'))) {
		if (typeof code.className !== 'string') continue
		if (!isRunnableHtmlCodeBlock(code.className)) continue
		const pre = code.parentElement
		if (!pre) continue

		const wrapper = doc.createElement('div')
		wrapper.className = 'ns-chatbox-runnable-code'

		const header = doc.createElement('div')
		header.className = 'ns-chatbox-runnable-code-header'
		const lang = doc.createElement('span')
		lang.className = 'ns-chatbox-runnable-code-lang'
		lang.textContent = 'HTML'
		const toggle = doc.createElement('button')
		toggle.type = 'button'
		toggle.className = 'ns-chatbox-runnable-code-toggle'
		const toggleIcon = doc.createElement('span')
		const toggleText = doc.createElement('span')
		toggle.append(toggleIcon, toggleText)
		header.append(lang, toggle)
		wrapper.appendChild(header)

		pre.replaceWith(wrapper)
		wrapper.appendChild(pre)

		const preview = doc.createElement('div')
		preview.className = 'ns-chatbox-runnable-code-preview'
		preview.hidden = true
		const iframe = doc.createElement('iframe')
		iframe.setAttribute(
			'sandbox',
			'allow-scripts allow-modals allow-forms allow-popups allow-downloads allow-pointer-lock',
		)
		preview.appendChild(iframe)
		wrapper.appendChild(preview)

		let previewing = false
		let loaded = false
		const syncToggle = () => {
			toggleIcon.className = previewing
				? ':uno: i-lucide-code size-3.5'
				: ':uno: i-lucide-play size-3.5'
			toggleText.textContent = toggleLabel(previewing)
		}
		syncToggle()
		toggle.addEventListener('click', () => {
			previewing = !previewing
			if (previewing && !loaded) {
				iframe.srcdoc = code.textContent ?? ''
				loaded = true
			}
			pre.hidden = previewing
			preview.hidden = !previewing
			syncToggle()
		})
	}
}
