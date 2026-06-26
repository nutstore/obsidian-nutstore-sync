import { z } from 'zod'
import { findLatestTodos } from '~/ai/chat/domain'
import { chatTodoItemSchema, type ChatTodoItem } from '~/ai/chat/types'
import type { AISession } from '~/ai/core/types'

export const todoWriteInputSchema = z.object({
	todos: z.array(chatTodoItemSchema).optional(),
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
	session: AISession,
) {
	if (!params.todos) {
		const todos = findLatestTodos(session)
		return {
			result: { todos },
			todos,
		}
	}

	const todos = normalizeTodoList(params.todos)
	return {
		result: { todos },
		todos,
	}
}
