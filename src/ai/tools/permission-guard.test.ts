import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createPermissionGuard,
	createReadonlyPermissionGuard,
	createFullAccessPermissionGuard,
	withPermissionPurpose,
} from './permission-guard'

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
		autoApproveBySession?: Map<string, Set<string>>
	},
) {
	const autoApproveBySession =
		options?.autoApproveBySession ?? new Map<string, Set<string>>()
	const runtimeStore = getRuntimeStore(sessionId, autoApproveBySession)
	const guard = createPermissionGuard({} as never, runtimeStore)
	return { guard, autoApproveBySession }
}

beforeEach(() => {
	modalOpenMock.mockReset()
	modalCtorMock.mockReset()
})

describe('createPermissionGuard', () => {
	it('passes the bound purpose to the modal without changing auto-approval', async () => {
		const { guard } = createGuard('session-1')
		const purposeGuard = withPermissionPurpose(
			guard,
			'更新中性备注 🌱 / Update neutral note',
		)!
		modalOpenMock.mockResolvedValueOnce('auto-approve-operation')

		await purposeGuard({
			type: 'fs',
			fs: { kind: 'write', path: 'notes/中性🌱.md' },
		})
		await purposeGuard({
			type: 'fs',
			fs: { kind: 'write', path: 'notes/another.md' },
		})

		expect(modalCtorMock).toHaveBeenCalledWith({
			app: {},
			request: {
				type: 'fs',
				fs: { kind: 'write', path: 'notes/中性🌱.md' },
				purpose: '更新中性备注 🌱 / Update neutral note',
			},
		})
		expect(modalOpenMock).toHaveBeenCalledTimes(1)
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

describe('createReadonlyPermissionGuard', () => {
	it('rejects write operations without opening any modal', async () => {
		const guard = createReadonlyPermissionGuard()

		await expect(
			guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } }),
		).rejects.toThrow('write on notes/a.md')

		expect(modalOpenMock).not.toHaveBeenCalled()
	})

	it('rejects delete operations', async () => {
		const guard = createReadonlyPermissionGuard()

		await expect(
			guard({ type: 'fs', fs: { kind: 'delete', path: 'notes/a.md' } }),
		).rejects.toThrow('delete on notes/a.md')
	})

	it('rejects mkdir operations', async () => {
		const guard = createReadonlyPermissionGuard()

		await expect(
			guard({ type: 'fs', fs: { kind: 'mkdir', path: 'notes/sub' } }),
		).rejects.toThrow('mkdir on notes/sub')
	})

	it('rejects move operations', async () => {
		const guard = createReadonlyPermissionGuard()

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

	it('mentions the read-only constraint in the error message', async () => {
		const guard = createReadonlyPermissionGuard()

		await expect(
			guard({ type: 'fs', fs: { kind: 'edit', path: 'notes/a.md' } }),
		).rejects.toThrow(/read-only/i)
	})
})

describe('createFullAccessPermissionGuard', () => {
	it('allows write operations without opening any modal', async () => {
		const guard = createFullAccessPermissionGuard()

		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })

		expect(modalOpenMock).not.toHaveBeenCalled()
	})

	it('allows delete operations without opening any modal', async () => {
		const guard = createFullAccessPermissionGuard()

		await guard({ type: 'fs', fs: { kind: 'delete', path: 'notes/a.md' } })

		expect(modalOpenMock).not.toHaveBeenCalled()
	})

	it('allows move operations without opening any modal', async () => {
		const guard = createFullAccessPermissionGuard()

		await guard({
			type: 'fs',
			fs: {
				kind: 'move',
				src: 'notes/a.md',
				dest: 'notes/b.md',
			},
		})

		expect(modalOpenMock).not.toHaveBeenCalled()
	})
})
