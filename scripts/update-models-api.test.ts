import { createRequire } from 'node:module'
import modelsApi from '../src/ai/models-api.json'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { filterCatalog, INCLUDED_PROVIDER_IDS } =
	require('./update-models-api.cjs') as {
		filterCatalog: <T>(catalog: Record<string, T>) => Record<string, T>
		INCLUDED_PROVIDER_IDS: Set<string>
	}

describe('update-models-api provider filtering', () => {
	it('only includes provider IDs that exist in api.json', () => {
		const providerIds = new Set(Object.keys(modelsApi))

		expect(
			[...INCLUDED_PROVIDER_IDS].filter((id) => !providerIds.has(id)),
		).toEqual([])
	})

	it('keeps approved providers and preserves their source order', () => {
		const catalog = {
			openai: { name: 'OpenAI' },
			perplexity: { name: 'Perplexity' },
			'amazon-bedrock': { name: 'Amazon Bedrock' },
			lmstudio: { name: 'LMStudio' },
		}

		expect(filterCatalog(catalog)).toEqual({
			openai: catalog.openai,
			'amazon-bedrock': catalog['amazon-bedrock'],
			lmstudio: catalog.lmstudio,
		})
	})

	it('matches exact provider IDs rather than similarly branded providers', () => {
		const catalog = {
			ollama: { name: 'Ollama' },
			'ollama-cloud': { name: 'Ollama Cloud' },
			'cloudflare-ai-gateway': { name: 'Cloudflare AI Gateway' },
			'cloudflare-workers-ai': { name: 'Cloudflare Workers AI' },
		}

		expect(Object.keys(filterCatalog(catalog))).toEqual([
			'ollama-cloud',
			'cloudflare-workers-ai',
		])
	})

	it('includes Xiaomi and its regional token plans', () => {
		const catalog = {
			xiaomi: { name: 'Xiaomi' },
			'xiaomi-token-plan-cn': { name: 'Xiaomi Token Plan (China)' },
			'xiaomi-token-plan-sgp': { name: 'Xiaomi Token Plan (Singapore)' },
			'xiaomi-token-plan-ams': { name: 'Xiaomi Token Plan (Europe)' },
		}

		expect(Object.keys(filterCatalog(catalog))).toEqual(Object.keys(catalog))
	})
})
