import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TFile } from 'obsidian'
import MemoTriggerService, {
	isMemoCandidatePath,
	type MemoTriggerState,
} from './memo-trigger.service'

const kv = vi.hoisted(() => ({
	get: vi.fn(),
	set: vi.fn(),
}))

vi.mock('~/storage/kv', () => ({
	memoTriggerKV: { get: kv.get, set: kv.set },
}))

function makeFile(path: string): TFile {
	const file = new TFile()
	;(file as unknown as { path: string }).path = path
	;(file as unknown as { extension: string }).extension = 'md'
	return file
}

interface FakePlugin {
	settings: {
		ai: {
			memoTrigger: {
				enabled: boolean
				threshold: number
				message: string
			}
		}
	}
	app: { vault: { on: ReturnType<typeof vi.fn> } }
	registerEvent: ReturnType<typeof vi.fn>
	chatService: { sendMessage: ReturnType<typeof vi.fn> }
}

function createFakePlugin(
	overrides: Partial<FakePlugin['settings']['ai']['memoTrigger']> = {},
): {
	plugin: FakePlugin
	vaultOn: FakePlugin['app']['vault']['on']
	sendMessage: FakePlugin['chatService']['sendMessage']
} {
	const vaultOn = vi.fn()
	const sendMessage = vi.fn().mockResolvedValue(true)
	const plugin: FakePlugin = {
		settings: {
			ai: {
				memoTrigger: {
					enabled: true,
					threshold: 2,
					message: '总结备忘录',
					...overrides,
				},
			},
		},
		app: { vault: { on: vaultOn } },
		registerEvent: vi.fn(),
		chatService: { sendMessage },
	}
	return { plugin, vaultOn, sendMessage }
}

async function loadService(plugin: FakePlugin) {
	const service = new MemoTriggerService(
		plugin as unknown as ConstructorParameters<typeof MemoTriggerService>[0],
	)
	await service.onload()
	return service
}

function createHandler(
	vaultOn: FakePlugin['app']['vault']['on'],
): (file: TFile) => void {
	return vaultOn.mock.calls[0][1]
}

describe('isMemoCandidatePath', () => {
	it('accepts plain markdown notes anywhere in the vault', () => {
		expect(isMemoCandidatePath('memo.md')).toBe(true)
		expect(isMemoCandidatePath('notes/2026-08-28.md')).toBe(true)
	})

	it('rejects non-markdown files', () => {
		expect(isMemoCandidatePath('image.png')).toBe(false)
		expect(isMemoCandidatePath('notes/data.json')).toBe(false)
	})

	it('rejects files under .obsidian and .agents', () => {
		expect(isMemoCandidatePath('.obsidian/workspace.json')).toBe(false)
		expect(isMemoCandidatePath('.agents/skills/memo-to-todo/SKILL.md')).toBe(
			false,
		)
	})

	it('rejects the vault welcome note', () => {
		expect(isMemoCandidatePath('欢迎.md')).toBe(false)
		expect(isMemoCandidatePath('welcome.md')).toBe(false)
	})
})

describe('MemoTriggerService', () => {
	beforeEach(() => {
		kv.get.mockReset().mockResolvedValue(undefined)
		kv.set.mockReset().mockResolvedValue(undefined)
	})

	it('does not count notes when the trigger is disabled', async () => {
		const { plugin, vaultOn, sendMessage } = createFakePlugin({
			enabled: false,
		})
		await loadService(plugin)
		const handler = createHandler(vaultOn)

		handler(makeFile('a.md'))
		handler(makeFile('b.md'))

		expect(sendMessage).not.toHaveBeenCalled()
		expect(kv.set).not.toHaveBeenCalled()
	})

	it('does not count non-candidate files', async () => {
		const { plugin, vaultOn, sendMessage } = createFakePlugin({
			threshold: 2,
		})
		await loadService(plugin)
		const handler = createHandler(vaultOn)

		handler(makeFile('.agents/skills/x/SKILL.md'))
		handler(makeFile('欢迎.md'))
		handler(makeFile('only-one-memo.md'))

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it('triggers the agent once the threshold of new notes is reached', async () => {
		const { plugin, vaultOn, sendMessage } = createFakePlugin({
			threshold: 2,
		})
		await loadService(plugin)
		const handler = createHandler(vaultOn)

		handler(makeFile('memo-1.md'))
		expect(sendMessage).not.toHaveBeenCalled()

		handler(makeFile('memo-2.md'))
		await vi.waitFor(() => {
			expect(sendMessage).toHaveBeenCalledTimes(1)
		})
		expect(sendMessage).toHaveBeenCalledWith('总结备忘录')

		// Count is reset after triggering: two more notes trigger again.
		handler(makeFile('memo-3.md'))
		handler(makeFile('memo-4.md'))
		await vi.waitFor(() => {
			expect(sendMessage).toHaveBeenCalledTimes(2)
		})
	})

	it('restores the counted set from KV storage', async () => {
		const stored: MemoTriggerState = { counted: ['memo-1.md'] }
		kv.get.mockResolvedValue(stored)
		const { plugin, vaultOn, sendMessage } = createFakePlugin({
			threshold: 2,
		})
		await loadService(plugin)
		const handler = createHandler(vaultOn)

		// One note was already counted before a restart; one more triggers.
		handler(makeFile('memo-2.md'))
		await vi.waitFor(() => {
			expect(sendMessage).toHaveBeenCalledTimes(1)
		})
	})

	it('persists the counted set after each creation', async () => {
		const { plugin, vaultOn } = createFakePlugin({ threshold: 5 })
		await loadService(plugin)
		const handler = createHandler(vaultOn)

		handler(makeFile('memo-1.md'))
		expect(kv.set).toHaveBeenLastCalledWith('memo_trigger', {
			counted: ['memo-1.md'],
		})
	})
})
