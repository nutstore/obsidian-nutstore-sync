import { bashTool } from './bash/tool'
import { editFileTool } from './edit-file'
import { noteNeighborhoodTool } from './note-neighborhood'
import { todoWriteTool } from './todowrite'
import { updateSessionTitleTool } from './update-session-title'
import { taskTool } from './task'

export interface CreateAIToolsOptions {
	allowSpawn?: boolean
	enableTodoWrite?: boolean
}

export function createAITools(options: CreateAIToolsOptions = {}) {
	return {
		...(options.enableTodoWrite ? { todowrite: todoWriteTool } : {}),
		update_session_title: updateSessionTitleTool,
		note_neighborhood: noteNeighborhoodTool,
		edit_file: editFileTool,
		bash: bashTool,
		...(options.allowSpawn !== false ? { task: taskTool } : {}),
	}
}
