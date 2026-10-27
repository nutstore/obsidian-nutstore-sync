// @vitest-environment jsdom
/* eslint-disable obsidianmd/prefer-create-el, obsidianmd/no-static-styles-assignment -- The test fixture supplies theme tokens directly on a browser DOM node. */
import { afterEach, describe, expect, it } from 'vitest'
import { readAppTheme } from './theme'

afterEach(() => {
	document.body.className = ''
	document.body.replaceChildren()
})

describe('App theme projection', () => {
	it('reads the active Obsidian scheme and semantic tokens', () => {
		document.body.className = 'theme-dark'
		const host = document.createElement('div')
		host.style.setProperty(
			'--font-interface',
			'"中性 Interface 🌿", sans-serif',
		)
		host.style.setProperty('--background-modifier-border', '#123456')
		host.style.setProperty('--radius-m', '9px')
		host.style.setProperty('--ns-private-layout', 'do-not-share')
		document.body.append(host)

		expect(readAppTheme(host)).toEqual({
			colorScheme: 'dark',
			properties: {
				'--font-interface': '"中性 Interface 🌿", sans-serif',
				'--background-modifier-border': '#123456',
				'--radius-m': '9px',
			},
		})
	})

	it('lets a nested light theme override the document scheme', () => {
		document.body.className = 'theme-dark'
		const host = document.createElement('div')
		const light = document.createElement('div')
		light.className = 'theme-light'
		light.append(host)
		document.body.append(light)

		expect(readAppTheme(host).colorScheme).toBe('light')
	})
})
/* eslint-enable obsidianmd/prefer-create-el, obsidianmd/no-static-styles-assignment -- Restore production lint rules after the theme fixture. */
