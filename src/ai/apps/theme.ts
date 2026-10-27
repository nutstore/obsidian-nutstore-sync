/**
 * Stable Obsidian design tokens exposed to sandboxed Apps. Keep this contract
 * limited to semantic theme values; component selectors and plugin internals
 * remain host concerns.
 */
export const APP_THEME_TOKENS = [
	'--font-interface',
	'--font-text',
	'--font-monospace',
	'--font-ui-smaller',
	'--font-ui-small',
	'--font-ui-medium',
	'--font-ui-large',
	'--text-normal',
	'--text-muted',
	'--text-faint',
	'--text-accent',
	'--text-accent-hover',
	'--text-on-accent',
	'--text-on-accent-inverted',
	'--text-error',
	'--text-success',
	'--text-selection',
	'--text-highlight-bg',
	'--text-highlight-bg-active',
	'--background-primary',
	'--background-primary-alt',
	'--background-secondary',
	'--background-secondary-alt',
	'--background-modifier-hover',
	'--background-modifier-active-hover',
	'--background-modifier-border',
	'--background-modifier-border-hover',
	'--background-modifier-border-focus',
	'--background-modifier-form-field',
	'--background-modifier-form-field-highlighted',
	'--background-modifier-success',
	'--background-modifier-error',
	'--background-modifier-error-hover',
	'--background-modifier-cover',
	'--interactive-normal',
	'--interactive-hover',
	'--interactive-accent',
	'--interactive-accent-hover',
	'--link-color',
	'--link-color-hover',
	'--link-external-color',
	'--link-external-color-hover',
	'--link-unresolved-color',
	'--link-unresolved-opacity',
	'--color-red',
	'--color-orange',
	'--color-yellow',
	'--color-green',
	'--color-cyan',
	'--color-blue',
	'--color-purple',
	'--color-pink',
	'--accent-h',
	'--accent-s',
	'--accent-l',
	'--radius-s',
	'--radius-m',
	'--radius-l',
	'--input-radius',
	'--button-radius',
	'--checkbox-radius',
	'--clickable-icon-radius',
	'--tab-radius',
	'--border-width',
	'--input-height',
	'--header-height',
	'--icon-size',
	'--icon-stroke',
	'--shadow-s',
	'--shadow-l',
	'--scrollbar-bg',
	'--scrollbar-thumb-bg',
	'--scrollbar-active-thumb-bg',
	'--scrollbar-width',
	'--tag-background',
	'--tag-background-hover',
	'--tag-color',
	'--tag-color-hover',
	'--tag-radius',
	'--code-background',
	'--code-normal',
	'--code-comment',
	'--code-function',
	'--code-important',
	'--code-keyword',
	'--code-property',
	'--code-punctuation',
	'--code-string',
	'--code-tag',
	'--code-value',
] as const

export type AppThemeToken = (typeof APP_THEME_TOKENS)[number]

export interface AppTheme {
	colorScheme: 'light' | 'dark'
	properties: Partial<Record<AppThemeToken, string>>
}

export function emptyAppTheme(): AppTheme {
	return { colorScheme: 'light', properties: {} }
}

/** Snapshot the host's semantic tokens once; AppRuntime forwards later changes. */
export function readAppTheme(container: HTMLElement): AppTheme {
	const doc = container.ownerDocument
	const win = doc.defaultView
	const properties: Partial<Record<AppThemeToken, string>> = {}
	if (win) {
		const computed = win.getComputedStyle(container)
		for (const key of APP_THEME_TOKENS) {
			const value = computed.getPropertyValue(key).trim()
			if (value) properties[key] = value
		}
	}
	return {
		colorScheme: resolveColorScheme(container, doc, win),
		properties,
	}
}

function resolveColorScheme(
	container: HTMLElement,
	doc: Document,
	win: Window | null,
): AppTheme['colorScheme'] {
	const themedHost = container.closest('.theme-dark, .theme-light')
	if (themedHost) {
		return themedHost.classList.contains('theme-dark') ? 'dark' : 'light'
	}
	if (doc.body.classList.contains('theme-dark')) return 'dark'
	if (doc.body.classList.contains('theme-light')) return 'light'
	return win?.matchMedia?.('(prefers-color-scheme: dark)').matches
		? 'dark'
		: 'light'
}
