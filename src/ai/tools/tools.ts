import { bashTool } from './bash/tool'
import { applyPatchTool } from './apply-patch'
import { noteNeighborhoodTool } from './note-neighborhood'
import { todoWriteTool } from './todowrite'
import { updateSessionTitleTool } from './update-session-title'
import { taskTool } from './task'
import { viewImageTool } from './view-image'

export interface CreateAIToolsOptions {
	allowSpawn?: boolean
	enableTodoWrite?: boolean
	enableViewImage?: boolean
}

export function createAITools(options: CreateAIToolsOptions = {}) {
	return {
		...(options.enableTodoWrite ? { todowrite: todoWriteTool } : {}),
		update_session_title: updateSessionTitleTool,
		note_neighborhood: noteNeighborhoodTool,
		apply_patch: applyPatchTool,
		bash: bashTool,
		...(options.enableViewImage ? { view_image: viewImageTool } : {}),
		...(options.allowSpawn !== false ? { task: taskTool } : {}),
	}
}
