import { describe, expect, it } from 'vitest'
import { ChatState } from '~/ai/chat/runtime/chat-state'
import { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import { UserContextManager } from './user-context-manager'

function createManager() {
	const state = new ChatState()
	const runtimeStates = new RuntimeStates(state)
	return new UserContextManager(state, runtimeStates, () => undefined)
}

describe('UserContextManager', () => {
	it('builds binary image file parts from user context without data URLs', async () => {
		const manager = createManager()
		const image = new Blob([new Uint8Array([1, 2, 3, 4])], {
			type: 'image/png',
		})

		const parts = await manager.buildMessagePartsFromUserContext([
			{
				type: 'image',
				hash: 'img-1',
				blob: image,
				mimeType: 'image/png',
				name: 'demo.png',
				size: image.size,
			},
		])

		expect(parts).toHaveLength(1)
		const imagePart = parts[0]
		expect(imagePart).toMatchObject({
			type: 'file',
			mediaType: 'image/png',
			filename: 'demo.png',
		})
		expect(imagePart?.type).toBe('file')
		if (!imagePart || imagePart.type !== 'file') {
			throw new Error('Expected an image file part')
		}
		expect(imagePart.data).toBeInstanceOf(Uint8Array)
		expect(imagePart.data).not.toBeTypeOf('string')
		expect(Array.from(imagePart.data as Uint8Array)).toEqual([1, 2, 3, 4])
	})

	it('keeps context metadata in user context message parts', async () => {
		const manager = createManager()
		const file = new Blob(['hello world'], { type: 'text/plain' })

		const parts = await manager.buildMessagePartsFromUserContext([
			{
				type: 'vault-path',
				hash: 'path-1',
				kind: 'file',
				path: 'notes/demo.md',
			},
			{
				type: 'file',
				hash: 'file-1',
				blob: file,
				mimeType: 'text/plain',
				filename: 'demo.txt',
				size: file.size,
			},
		])

		expect(parts).toHaveLength(2)
		expect(parts[0]).toMatchObject({ type: 'text' })
		expect((parts[0] as { text: string }).text).toContain('notes/demo.md')
		expect(parts[1]).toMatchObject({ type: 'text' })
		expect((parts[1] as { text: string }).text).toContain(
			'"filename": "demo.txt"',
		)
	})
})
