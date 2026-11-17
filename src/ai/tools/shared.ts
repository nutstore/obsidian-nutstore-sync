import * as z from 'zod/mini'
import i18n from '~/i18n'

export const textValue = (field: string) =>
	z.string({
		error: () => i18n.t('chatbox.errors.toolFieldRequired', { field }),
	})

export const booleanValue = (field: string) =>
	z.pipe(
		z.transform((value: unknown) => {
			if (typeof value === 'boolean') {
				return value
			}
			if (typeof value === 'string') {
				const normalized = value.trim().toLowerCase()
				if (normalized === 'true') {
					return true
				}
				if (normalized === 'false') {
					return false
				}
			}
			return value
		}),
		z.boolean(i18n.t('chatbox.errors.toolFieldRequired', { field })),
	)
