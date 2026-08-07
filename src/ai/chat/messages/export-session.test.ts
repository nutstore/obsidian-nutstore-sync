import { describe, expect, it } from 'vitest'
import { sanitizeExportFileName } from './export-session'

describe('sanitizeExportFileName', () => {
	it('normalizes an English title and removes unsupported characters', () => {
		expect(sanitizeExportFileName('  Project / notes: overview?  ')).toBe(
			'Project - notes- overview-',
		)
	})

	it('limits a long English title by UTF-8 byte length', () => {
		const title = sanitizeExportFileName('a'.repeat(300))

		expect(new TextEncoder().encode(title).byteLength).toBe(200)
		expect(title).toBe('a'.repeat(200))
	})

	it('limits a long Chinese title without splitting a character', () => {
		const title = sanitizeExportFileName('示例内容'.repeat(100))

		expect(new TextEncoder().encode(title).byteLength).toBe(198)
		expect(title).toBe('示例内容'.repeat(100).slice(0, 66))
	})

	it('uses a fallback when sanitization leaves no title', () => {
		expect(sanitizeExportFileName(' ... ')).toBe('chat-session')
	})
})
