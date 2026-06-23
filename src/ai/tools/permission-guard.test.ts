import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPermissionGuard } from './permission-guard'

const { modalOpenMock, modalCtorMock } = vi.hoisted(() => ({
	modalOpenMock: vi.fn(),
	modalCtorMock: vi.fn(),
}))

vi.mock('~/components/AIPermissionModal', () => ({
	default: vi.fn().mockImplementation((app, request) => {
		modalCtorMock({ app, request })
		return {
			open: modalOpenMock,
		}
	}),
}))

function getRuntimeStore(
	sessionId: string,
	autoApproveBySession: Map<string, Set<string>>,
) {
	return {
		has(signature: string) {
			return autoApproveBySession.get(sessionId)?.has(signature) ?? false
		},
		add(signature: string) {
			const requests = autoApproveBySession.get(sessionId) ?? new Set()
			requests.add(signature)
			autoApproveBySession.set(sessionId, requests)
		},
	}
}

function createGuard(
	sessionId: string,
	options?: {
		yolo?: boolean
		autoApproveBySession?: Map<string, Set<string>>
	},
) {
	const settings = {
		ai: {
			yolo: options?.yolo ?? false,
		},
	} as never

	const autoApproveBySession =
		options?.autoApproveBySession ?? new Map<string, Set<string>>()
	const runtimeStore = getRuntimeStore(sessionId, autoApproveBySession)
	const guard = createPermissionGuard({} as never, () => settings, runtimeStore)
	return { guard, autoApproveBySession }
}

describe('createPermissionGuard', () => {
	beforeEach(() => {
		modalOpenMock.mockReset()
		modalCtorMock.mockReset()
	})

	it('bypasses modal when yolo is enabled', async () => {
		const { guard } = createGuard('session-1', { yolo: true })

		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })

		expect(modalOpenMock).not.toHaveBeenCalled()
	})

	it('approve only affects the current request', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock
			.mockResolvedValueOnce('approve')
			.mockResolvedValueOnce('approve')

		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })
		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/b.md' } })

		expect(modalOpenMock).toHaveBeenCalledTimes(2)
	})

	it('auto-approve skips future prompts for same kind in same session', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('auto-approve-operation')

		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })
		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/b.md' } })

		expect(modalOpenMock).toHaveBeenCalledTimes(1)
	})

	it('different kinds in same session still prompt after auto-approve', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock
			.mockResolvedValueOnce('auto-approve-operation')
			.mockResolvedValueOnce('approve')

		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })
		await guard({ type: 'fs', fs: { kind: 'delete', path: 'notes/a.md' } })

		expect(modalOpenMock).toHaveBeenCalledTimes(2)
		expect(modalCtorMock).toHaveBeenNthCalledWith(1, {
			app: {},
			request: { type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } },
		})
		expect(modalCtorMock).toHaveBeenNthCalledWith(2, {
			app: {},
			request: { type: 'fs', fs: { kind: 'delete', path: 'notes/a.md' } },
		})
	})

	it('same kind in different sessions still prompts', async () => {
		const autoApproveBySession = new Map<string, Set<string>>()
		const guardA = createGuard('session-a', { autoApproveBySession }).guard
		const guardB = createGuard('session-b', { autoApproveBySession }).guard
		modalOpenMock
			.mockResolvedValueOnce('auto-approve-operation')
			.mockResolvedValueOnce('approve')

		await guardA({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })
		await guardB({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })

		expect(modalOpenMock).toHaveBeenCalledTimes(2)
	})

	it('passes copy requests through to the modal', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('approve')

		await guard({
			type: 'fs',
			fs: {
				kind: 'copy',
				src: 'notes/a.md',
				dest: 'notes/b.md',
			},
		})

		expect(modalCtorMock).toHaveBeenCalledWith({
			app: {},
			request: {
				type: 'fs',
				fs: {
					kind: 'copy',
					src: 'notes/a.md',
					dest: 'notes/b.md',
				},
			},
		})
	})

	it('throws an error when user denies a single-path request', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('deny')

		await expect(
			guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } }),
		).rejects.toThrow('write on notes/a.md')
	})

	it('throws an error when user denies a dual-path request', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('deny')

		await expect(
			guard({
				type: 'fs',
				fs: {
					kind: 'move',
					src: 'notes/a.md',
					dest: 'notes/b.md',
				},
			}),
		).rejects.toThrow('move from notes/a.md to notes/b.md')
	})
})
