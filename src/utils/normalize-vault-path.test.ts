import { describe, expect, it } from 'vitest'
import { normalizeVaultPath } from './normalize-vault-path'

describe('normalizeVaultPath', () => {
	it('normalizes neutral English, Chinese, and Emoji Vault paths', () => {
		expect(normalizeVaultPath('/notes/中性 🌱.md/')).toBe('notes/中性 🌱.md')
		expect(normalizeVaultPath('notes\\neutral.txt')).toBe('notes/neutral.txt')
	})

	it('maps an empty path to the Vault root', () => {
		expect(normalizeVaultPath('')).toBe('')
	})
})
