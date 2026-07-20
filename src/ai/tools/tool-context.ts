import { z } from 'zod/mini'
import type { App } from 'obsidian'
import type { IFileSystem } from 'just-bash/browser'
import type { ChatSession } from '~/ai/chat/domain'
import type { ReadTracker } from '~/ai/tools/file-operation'
import type { AppToolMetadata } from '~/ai/core/types'
import type { PermissionGuard } from '~/ai/tools/permission-guard'

export type RecordMetadataFn = (
	toolCallId: string,
	metadata: AppToolMetadata,
) => void

export const appDep = z.custom<App>()
export const permissionGuardDep = z.optional(z.custom<PermissionGuard>())
export const scratchDep = z.custom<IFileSystem>()
export const sessionDep = z.custom<ChatSession>()
export const agentIdDep = z.string()
export const readTrackerDep = z.optional(z.custom<ReadTracker>())
export const recordMetadataDep = z.optional(z.custom<RecordMetadataFn>())
