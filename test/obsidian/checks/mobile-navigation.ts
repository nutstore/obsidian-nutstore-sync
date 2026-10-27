import type { View } from 'obsidian'
import { assert } from './assert'

/** Verify actual content bounds under the host's navigation and keyboard CSS. */
export async function assertViewAboveMobileNavigation(
	view: View,
	bottomElementSelector: string,
) {
	const content = view.containerEl.querySelector<HTMLElement>('.view-content')!
	const wrapper = view.containerEl.parentElement!
	const originalContentStyle = content.getAttribute('style')
	const originalClass = wrapper.className
	const originalStyle = wrapper.getAttribute('style')
	try {
		for (const overrides of [
			{},
			{ safe: 34, offset: 34, reserve: 82 },
			{ width: 650, height: 330 },
			{ height: 350, safe: 34, offset: 34, keyboard: 300, reserve: 0 },
			{ hidden: true, reserve: 0 },
			{ floating: false, reserve: 0 },
			{ phone: false, width: 768, reserve: 0 },
		]) {
			const state = {
				width: 390,
				height: 650,
				safe: 0,
				offset: 12,
				keyboard: 0,
				phone: true,
				floating: true,
				hidden: false,
				reserve: 60,
				...overrides,
			}
			wrapper.toggleClass('is-phone', state.phone)
			wrapper.toggleClass('is-floating-nav', state.floating)
			wrapper.toggleClass('is-hidden-nav', state.hidden)
			wrapper.setCssProps({
				'--safe-area-inset-bottom': `${state.safe}px`,
				'--navbar-height': '48px',
				'--navbar-bottom-offset': `${state.offset}px`,
				'--keyboard-height': `${state.keyboard}px`,
			})
			content.setCssStyles({
				width: `${state.width}px`,
				height: `${state.height}px`,
				flex: 'none',
			})
			await new Promise<void>((resolve) =>
				window.requestAnimationFrame(() =>
					window.requestAnimationFrame(() => resolve()),
				),
			)
			const padding = Number.parseFloat(getComputedStyle(content).paddingBottom)
			assert(
				state.reserve
					? padding >= state.reserve
					: padding <= Math.max(state.safe, 32),
				`View reserved the wrong mobile navigation space: ${padding}px, ${JSON.stringify(state)}`,
			)
			const bottomElement = content.querySelector<HTMLElement>(
				bottomElementSelector,
			)!
			assert(
				bottomElement && bottomElement.offsetHeight > 0,
				'View content is not visible',
			)
			assert(
				bottomElement.getBoundingClientRect().bottom <=
					content.getBoundingClientRect().bottom - state.reserve + 1,
				'Mobile navigation overlaps the view content',
			)
		}
	} finally {
		if (originalContentStyle === null) content.removeAttribute('style')
		else content.setAttribute('style', originalContentStyle)
		wrapper.className = originalClass
		if (originalStyle === null) wrapper.removeAttribute('style')
		else wrapper.setAttribute('style', originalStyle)
	}
}
