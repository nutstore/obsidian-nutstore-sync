import i18n from '~/i18n'

export interface AppCreationDetails {
	name: string
	description: string
}

/**
 * A new App starts as an editable chat draft. The description is the required
 * brief; the optional name stays a separate instruction so omitting it does not
 * create placeholder content.
 */
export function formatAppCreationPrompt({
	name,
	description,
}: AppCreationDetails): string {
	const trimmedDescription = description.trim()
	if (!trimmedDescription) return ''

	const sections = [i18n.t('apps.createPrompt'), trimmedDescription]
	const trimmedName = name.trim()
	if (trimmedName) {
		sections.push(i18n.t('apps.createPromptName', { name: trimmedName }))
	}
	return sections.join('\n\n')
}
