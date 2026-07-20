import { tool } from 'ai'
import { z } from 'zod/mini'
import type { ChatSession } from '~/ai/chat/domain'
import { findLatestTodos } from '~/ai/chat/domain'
import { chatTodoItemSchema, type ChatTodoItem } from '~/ai/chat/types'
import { recordMetadataDep, sessionDep } from './tool-context'

export const todoWriteInputSchema = z.object({
	todos: z.optional(z.array(chatTodoItemSchema)),
})

export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>

function normalizeTodoList(inputTodos: NonNullable<TodoWriteInput['todos']>) {
	return inputTodos.map(
		(input): ChatTodoItem => ({
			content: input.content,
			status: input.status,
			priority: input.priority,
		}),
	)
}

export async function executeTodoWrite(
	params: TodoWriteInput,
	session: ChatSession,
) {
	if (!params.todos) {
		const todos = findLatestTodos(session)
		return { todos }
	}

	const todos = normalizeTodoList(params.todos)
	return { todos }
}

export const todoWriteTool = tool({
	description:
		'Create, update, query, and maintain a structured todo list for the current coding session. Use it proactively when work has more than three steps, needs planning, or the user explicitly asks for task tracking. Call without todos to query the current list. Call with the complete current todos array to save the list. Each todo contains only content, status, and priority. Status values are pending, in_progress, completed, or cancelled. Priority values are high, medium, or low. Keep exactly one active todo in in_progress when possible, update progress in real time, and do not batch-complete multiple todos at the end.',
	inputSchema: todoWriteInputSchema,
	contextSchema: z.object({
		session: sessionDep,
		recordMetadata: recordMetadataDep,
	}),
	outputSchema: z.object({ todos: z.array(chatTodoItemSchema) }),
	execute: async (params, { context, toolCallId }) => {
		const output = await executeTodoWrite(params, context.session)
		context.recordMetadata?.(toolCallId, { todos: output.todos })
		return output
	},
	toModelOutput: ({ output }) => {
		const { todos } = output
		if (!todos?.length) {
			return { type: 'text', value: 'The todo list is empty.' }
		}
		return {
			type: 'text',
			value: `Todo list:\n${todos
				.map((todo) => `- [${todo.status}] ${todo.content} (${todo.priority})`)
				.join('\n')}`,
		}
	},
})
