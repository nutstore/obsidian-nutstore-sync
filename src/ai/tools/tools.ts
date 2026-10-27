import { agentCommunicationTools } from './agent-communication'
import { bashTool } from './bash/tool'
import { applyPatchTool } from './apply-patch'
import { memoryTool } from './memory'
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
		...agentCommunicationTools,
		...(options.enableTodoWrite ? { todowrite: todoWriteTool } : {}),
		update_session_title: updateSessionTitleTool,
		apply_patch: applyPatchTool,
		bash: bashTool,
		memory: memoryTool,
		...(options.enableViewImage ? { view_image: viewImageTool } : {}),
		...(options.allowSpawn !== false ? { task: taskTool } : {}),
	}
}
