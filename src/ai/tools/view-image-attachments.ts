import type { FilePart, ToolCallPart, UserModelMessage } from 'ai'

export interface ViewImageAttachmentRegistry {
	register(toolCallId: string, file: FilePart): void
	takeUninjected(toolCalls: ToolCallPart[]): FilePart[]
}

export class InMemoryViewImageAttachmentRegistry implements ViewImageAttachmentRegistry {
	private attachments = new Map<string, FilePart>()
	private injectedToolCallIds = new Set<string>()

	register(toolCallId: string, file: FilePart) {
		this.attachments.set(toolCallId, file)
	}

	takeUninjected(toolCalls: ToolCallPart[]) {
		const files: FilePart[] = []
		for (const toolCall of toolCalls) {
			if (this.injectedToolCallIds.has(toolCall.toolCallId)) continue
			const file = this.attachments.get(toolCall.toolCallId)
			if (!file) continue
			this.injectedToolCallIds.add(toolCall.toolCallId)
			files.push(file)
		}
		return files
	}
}

export function createViewImageAttachmentMessage(
	attachments: FilePart[],
): UserModelMessage | undefined {
	if (!attachments.length) return undefined
	return {
		role: 'user',
		content: attachments.flatMap((file) => [
			{
				type: 'text' as const,
				text: 'The image from the preceding view_image result is attached for visual inspection.',
			},
			file,
		]),
	}
}
