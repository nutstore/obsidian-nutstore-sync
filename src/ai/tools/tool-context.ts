import { z } from 'zod/mini'
import type { App } from 'obsidian'
import type { ChatSession } from '~/ai/chat/domain'
import type { ReadTracker } from '~/ai/tools/file-operation'
import type { AppToolMetadata } from '~/ai/core/types'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import type { ViewImageAttachmentRegistry } from '~/ai/tools/view-image-attachments'
import type { NormalizedSettingsPatch } from './settings-whitelist'
import type { NutstoreSettings } from '~/settings'
import type { VaultFileSystemManager } from './vault-filesystem'

export type RecordMetadataFn = (
	toolCallId: string,
	metadata: AppToolMetadata,
) => void

export type SettingsUpdater = (patch: NormalizedSettingsPatch) => Promise<void>
export type SettingsSnapshotFn = () => NutstoreSettings

export const appDep = z.custom<App>()
export const permissionGuardDep = z.optional(z.custom<PermissionGuard>())
export const sessionDep = z.custom<ChatSession>()
export const agentIdDep = z.string()
export const readTrackerDep = z.optional(z.custom<ReadTracker>())
export const recordMetadataDep = z.optional(z.custom<RecordMetadataFn>())
export const viewImageAttachmentsDep = z.optional(
	z.custom<ViewImageAttachmentRegistry>(),
)
export const getSettingsSnapshotDep = z.optional(z.custom<SettingsSnapshotFn>())
export const updateSettingsDep = z.optional(z.custom<SettingsUpdater>())
export const fileSystemManagerDep = z.optional(
	z.custom<VaultFileSystemManager>(),
)
