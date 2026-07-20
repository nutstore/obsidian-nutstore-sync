import { tool } from 'ai'
import { z } from 'zod/mini'
import i18n from '~/i18n'
import { textValue } from './shared'
import { recordMetadataDep } from './tool-context'

export const updateSessionTitleTool = tool({
	description:
		'Update the title of the current chat session. Call this once after the first user message to summarize the conversation topic as a concise title (at most 6 words, no surrounding quotes, no trailing punctuation). Do not call it again unless the user explicitly asks to rename the session.',
	inputSchema: z.object({
		title: textValue('title').check(
			z.maxLength(
				80,
				i18n.t('chatbox.errors.toolFieldTooLong', { field: 'title' }),
			),
		),
	}),
	contextSchema: z.object({
		recordMetadata: recordMetadataDep,
	}),
	outputSchema: z.object({
		updated: z.literal(true),
		title: z.string(),
	}),
	execute: async (params, { context, toolCallId }) => {
		const title = params.title.trim()
		context.recordMetadata?.(toolCallId, { sessionTitle: title })
		return { updated: true as const, title }
	},
	toModelOutput: ({ output }) => ({
		type: 'text',
		value: `Session title updated to "${output.title}".`,
	}),
})
