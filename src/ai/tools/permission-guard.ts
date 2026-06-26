import type { App } from 'obsidian'
import type { ChatModalMountTarget } from '~/ai/chat/ui/modal-mount'
import AIPermissionModal from '~/components/AIPermissionModal'
import i18n from '~/i18n'
import type { NutstoreSettings } from '~/settings'
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
	sessionTitle?: string
}

export interface FSDualPathPermissionRequest {
	type: 'fs'
	fs: {
		kind: AIDualPathFileOperation
		src: string
		dest: string
	}
	sessionTitle?: string
}

export type FSPermissionRequest =
	| FSSinglePathPermissionRequest
	| FSDualPathPermissionRequest

export type PermissionRequest = FSPermissionRequest
export type PermissionGuard = (request: PermissionRequest) => Promise<void>

interface RuntimeAutoApproveOperationStore {
	has(signature: string): boolean
	add(signature: string): void
}

function isDualPathRequest(
	request: FSPermissionRequest,
): request is FSDualPathPermissionRequest {
	return request.fs.kind === 'copy' || request.fs.kind === 'move'
}

export function getPermissionRequestOperationSignature(
	request: FSPermissionRequest,
) {
	return request.fs.kind
}

function formatDeniedSummary(request: FSPermissionRequest) {
	const { kind } = request.fs
	if (isDualPathRequest(request)) {
		return `${kind} from ${request.fs.src} to ${request.fs.dest}`
	}
	return `${kind} on ${request.fs.path}`
}

export function createPermissionGuard(
	app: App,
	getSettings: () => NutstoreSettings,
	runtimeAutoApproveOperationStore?: RuntimeAutoApproveOperationStore,
	context?: { sessionTitle?: string; modalMountTarget?: ChatModalMountTarget },
): PermissionGuard {
	return async (request: PermissionRequest) => {
		const settings = getSettings()

		if (settings.ai.yolo) {
			return
		}

		const signature = getPermissionRequestOperationSignature(request)
		if (runtimeAutoApproveOperationStore?.has(signature)) {
			return
		}

		const result = await new AIPermissionModal(
			app,
			{
				...request,
				sessionTitle: context?.sessionTitle,
			},
			context?.modalMountTarget,
		).open()

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
