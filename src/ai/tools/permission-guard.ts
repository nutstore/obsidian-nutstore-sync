import type { App } from 'obsidian'
import type { ChatModalMountTarget } from '~/ai/chat/ui/modal-mount'
import AIPermissionModal from '~/components/AIPermissionModal'
import i18n from '~/i18n'
import type {
	AIDualPathFileOperation,
	AISinglePathFileOperation,
} from './file-operation'

export interface FSSinglePathPermissionRequest {
	type: 'fs'
	fs: {
		kind: AISinglePathFileOperation
		path: string
	}
	purpose?: string
	sessionTitle?: string
}

export interface FSDualPathPermissionRequest {
	type: 'fs'
	fs: {
		kind: AIDualPathFileOperation
		src: string
		dest: string
	}
	purpose?: string
	sessionTitle?: string
}

export interface SettingsPermissionRequest {
	type: 'settings'
	settings: {
		action: 'update'
		summary: string
		changes: unknown
	}
	purpose?: string
	sessionTitle?: string
}

export type PermissionRequest =
	| FSSinglePathPermissionRequest
	| FSDualPathPermissionRequest
	| SettingsPermissionRequest
export type PermissionGuard = (request: PermissionRequest) => Promise<void>

/**
 * Binds the user-facing purpose of a tool call to every permission request it
 * causes. Operation signatures deliberately remain based on the operation,
 * not this explanatory text.
 */
export function withPermissionPurpose(
	permissionGuard: PermissionGuard | undefined,
	purpose: string,
): PermissionGuard | undefined {
	if (!permissionGuard) return undefined
	return async (request) => permissionGuard({ ...request, purpose })
}

interface RuntimeAutoApproveOperationStore {
	has(signature: string): boolean
	add(signature: string): void
}

function isDualPathRequest(
	request: PermissionRequest,
): request is FSDualPathPermissionRequest {
	return (
		request.type === 'fs' &&
		(request.fs.kind === 'copy' || request.fs.kind === 'move')
	)
}

export function getPermissionRequestOperationSignature(
	request: PermissionRequest,
) {
	if (request.type === 'settings') {
		return `settings:${request.settings.action}`
	}
	return request.fs.kind
}

function formatDeniedSummary(request: PermissionRequest) {
	if (request.type === 'settings') {
		return request.settings.summary
	}
	const { kind } = request.fs
	if (isDualPathRequest(request)) {
		return `${kind} from ${request.fs.src} to ${request.fs.dest}`
	}
	return `${kind} on ${request.fs.path}`
}

export function createPermissionGuard(
	app: App,
	runtimeAutoApproveOperationStore?: RuntimeAutoApproveOperationStore,
	context?: { sessionTitle?: string; modalMountTarget?: ChatModalMountTarget },
): PermissionGuard {
	return async (request: PermissionRequest) => {
		const signature = getPermissionRequestOperationSignature(request)
		if (runtimeAutoApproveOperationStore?.has(signature)) {
			return
		}

		const modal = new AIPermissionModal(
			app,
			{
				...request,
				sessionTitle: context?.sessionTitle,
			},
			context?.modalMountTarget,
		)
		// `openAndWait` is the plugin modal's result-aware API. Keep a small
		// compatibility path for test doubles and older integrations that expose
		// the original Promise-returning `open` method only.
		const result =
			typeof modal.openAndWait === 'function'
				? await modal.openAndWait()
				: await (modal.open() as unknown as Promise<string>)

		if (result === 'deny') {
			throw new Error(
				i18n.t('aiPermission.denied', {
					summary: formatDeniedSummary(request),
				}),
			)
		}

		if (result === 'auto-approve-operation') {
			runtimeAutoApproveOperationStore?.add(signature)
		}
	}
}

export function createReadonlyPermissionGuard(): PermissionGuard {
	return async (request: PermissionRequest) => {
		throw new Error(
			i18n.t('aiPermission.readonly', {
				summary: formatDeniedSummary(request),
			}),
		)
	}
}

export function createFullAccessPermissionGuard(): PermissionGuard {
	return async () => {}
}
