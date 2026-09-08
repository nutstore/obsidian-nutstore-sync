import type { ModelMessage } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { createProviderConfig } from '../catalog/config'

vi.mock('../providers/registry', () => ({
	getProviderResolver: () => ({
		assertUsable: () => undefined,
		createLanguageModel: () => undefined,
	}),
}))

import { prepareMessagesForModel } from './runtime'

const genericFile = {
	type: 'file' as const,
	mediaType: 'application/octet-stream',
	data: 'neutral-file-data',
	filename: '中性🌿.bin',
}

describe('AI message modality adaptation', () => {
	it('keeps generic files for models that support file input', () => {
		const provider = createProviderConfig({
			id: 'provider-1',
			models: {
				'model-1': {
					id: 'model-1',
					name: '中性🌿模型',
					modalities: {
						input: ['text', 'file'],
						output: ['text'],
					},
				},
			},
		})
		const messages: ModelMessage[] = [
			{
				role: 'user',
				content: [{ type: 'text', text: '中性🌿文本' }, genericFile],
			},
		]

		const prepared = prepareMessagesForModel(provider, 'model-1', messages)

		expect(prepared[0]).toMatchObject({
			role: 'user',
			content: [{ type: 'text', text: '中性🌿文本' }, genericFile],
		})
	})

	it('replaces generic files for models without file input support', () => {
		const provider = createProviderConfig({
			id: 'provider-1',
			models: {
				'model-1': {
					id: 'model-1',
					name: '中性🌿模型',
					modalities: {
						input: ['text'],
						output: ['text'],
					},
				},
			},
		})
		const messages: ModelMessage[] = [
			{
				role: 'user',
				content: [genericFile],
			},
		]

		const prepared = prepareMessagesForModel(provider, 'model-1', messages)

		expect(prepared[0]).toMatchObject({
			content: [
				{
					type: 'text',
					text: '[file attached: 中性🌿.bin, unavailable to this model.]',
				},
			],
		})
	})
})
