import { describe, expect, it } from 'vitest'
import type { UserModelMessage } from 'ai'
import {
	migrateDeprecatedImageParts,
	needsDeprecatedImagePartMigration,
} from './message-utils'

describe('deprecated image part migration', () => {
	it('converts an image part while preserving multilingual text', () => {
		const message: UserModelMessage = {
			role: 'user',
			content: [
				{ type: 'text', text: 'Neutral English 中文 🧩' },
				{
					type: 'image',
					image: 'data:image/png;base64,AA==',
					mediaType: 'image/png',
				},
			],
		}

		expect(needsDeprecatedImagePartMigration(message)).toBe(true)
		expect(migrateDeprecatedImageParts(message)).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'Neutral English 中文 🧩' },
				{
					type: 'file',
					data: 'data:image/png;base64,AA==',
					mediaType: 'image/png',
				},
			],
		})
	})

	it('reuses a message that has no deprecated image part', () => {
		const message: UserModelMessage = {
			role: 'user',
			content: [{ type: 'text', text: 'Neutral 中文 🧩' }],
		}

		expect(needsDeprecatedImagePartMigration(message)).toBe(false)
		expect(migrateDeprecatedImageParts(message)).toBe(message)
	})
})
