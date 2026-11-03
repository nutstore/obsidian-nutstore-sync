import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AIProviderConfig } from '~/ai/core/types'
import type NutstorePlugin from '~/index'
import { createProviderConfig } from '~/ai/catalog/config'
import { ModuleScope } from '~/modules/lifecycle'
import NutstoreLlmGatewayService, {
	type NutstoreLlmGatewayAuthSettings,
} from './nutstore-llm-gateway.service'

const { createAuthorization, poll, cancelDevice, fetchMock } = vi.hoisted(
	() => ({
		createAuthorization: vi.fn(),
		poll: vi.fn(),
		cancelDevice: vi.fn(),
		fetchMock: vi.fn(),
	}),
)
vi.mock('obsidian', () => ({ Notice: class {} }))
vi.mock('~/consts', () => ({
	LLM_GATEWAY_CLIENT_ID: 'neutral-client',
	NUTSTORE_LLM_GATEWAY_PROVIDER_ID: 'gateway',
}))
vi.mock('@nutstore/sso-js', () => ({
	LlmGatewayClient: class {
		createDeviceAuthorization = createAuthorization
		pollDeviceToken = poll
		cancelDeviceAuthorization = cancelDevice
		createVerificationUrl() {
			return 'https://example.invalid/authorization'
		}
		getLlmGatewayEndpoints() {
			return { models: 'https://example.invalid/models' }
		}
	},
}))
vi.mock('~/ai/transport/obsidian-fetch', () => ({ obsidianFetch: fetchMock }))
vi.mock('~/utils/logger', () => ({ default: { error: vi.fn() } }))

afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
})

function fixture() {
	const settings = {
		ai: {
			nutstoreLlmGateway: {} as NutstoreLlmGatewayAuthSettings,
			providers: {} as Record<string, AIProviderConfig>,
			defaultModel: undefined as
				{ providerId: string; modelId: string } | undefined,
		},
	}
	const save = vi.fn(async () => {})
	const plugin = {
		settings,
		settingsService: { saveSettings: save },
	} as unknown as NutstorePlugin
	const scope = new ModuleScope()
	const service = new NutstoreLlmGatewayService(plugin, scope)
	return { plugin, settings, scope, service, save }
}

describe('gateway lifetime', () => {
	it('lists configured providers consistently with gateway authorization', () => {
		const f = fixture()
		const gateway = createProviderConfig({
			id: 'gateway',
			name: '中性 Gateway 🌱',
		})
		const other = createProviderConfig({
			id: 'other',
			name: '其他 Provider 🌿',
		})
		f.plugin.settings.ai.providers = { gateway, other }

		expect(f.service.listConfiguredProviders()).toEqual([other])
		Object.assign(f.settings.ai.nutstoreLlmGateway, {
			accessToken: 'neutral-token',
			refreshToken: 'neutral-refresh',
		})
		expect(f.service.listConfiguredProviders()).toEqual([gateway, other])
		expect(f.plugin.settings.ai.providers).toEqual({ gateway, other })
	})

	it('cancels only the pending authorization and keeps the existing account', async () => {
		const f = fixture()
		Object.assign(f.settings.ai.nutstoreLlmGateway, {
			accessToken: '{{SECRET_existing_access}}',
			refreshToken: '{{SECRET_existing_refresh}}',
			pendingAuthorization: {
				clientId: 'neutral-client',
				deviceCode: 'neutral-device',
				userCode: 'neutral-code',
				verificationUri: 'https://example.invalid/',
				verificationUrl: 'https://example.invalid/',
				intervalMs: 1000,
				expiresAt: Date.now() + 60_000,
			},
		})

		await f.service.cancelAuthorization()

		expect(cancelDevice).toHaveBeenCalledWith({
			deviceCode: 'neutral-device',
		})
		expect(
			f.settings.ai.nutstoreLlmGateway.pendingAuthorization,
		).toBeUndefined()
		expect(f.settings.ai.nutstoreLlmGateway.accessToken).toBe(
			'{{SECRET_existing_access}}',
		)
		expect(f.settings.ai.nutstoreLlmGateway.refreshToken).toBe(
			'{{SECRET_existing_refresh}}',
		)
	})

	it('selects the first fetched model when no valid default exists', async () => {
		const f = fixture()
		Object.assign(f.settings.ai.nutstoreLlmGateway, {
			accessToken: '{{SECRET_current_access}}',
			refreshToken: '{{SECRET_current_refresh}}',
			accessTokenExpiresAt: Date.now() + 120_000,
		})
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{
							id: 'model-neutral-zh',
							name: '中性模型 🌱',
							description: '',
							api: 'openai-completions',
							reasoning: false,
							input: ['text'],
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
							},
							contextWindow: 0,
							maxTokens: 0,
							compat: {
								thinkingFormat: 'openai',
								supportsReasoningEffort: false,
							},
						},
					],
				}),
			),
		)

		await expect(f.service.refreshModels()).resolves.toBe(true)

		expect(f.settings.ai.defaultModel).toEqual({
			providerId: 'gateway',
			modelId: 'model-neutral-zh',
		})
	})

	it('cannot install a pending authorization or polling after a late authorization response', async () => {
		const f = fixture()
		let respond!: (value: unknown) => void
		createAuthorization.mockImplementation(
			() =>
				new Promise((resolve) => {
					respond = resolve
				}),
		)
		const request = f.service.startAuthorization()
		const rejected = expect(request).rejects.toMatchObject({
			name: 'AbortError',
		})
		f.scope.close()
		f.service.onunload()
		respond({
			device_code: 'neutral-device',
			user_code: 'neutral-code',
			verification_uri: 'https://example.invalid/',
			interval: 1,
			expires_in: 60,
		})
		await rejected
		expect(f.settings.ai.nutstoreLlmGateway).toEqual({})
		expect(f.save).not.toHaveBeenCalled()
		expect(poll).not.toHaveBeenCalled()
	})

	it('a pending poll completing after shutdown does not schedule another poll', async () => {
		vi.useFakeTimers()
		const f = fixture()
		Object.assign(f.settings.ai.nutstoreLlmGateway, {
			pendingAuthorization: {
				clientId: 'neutral-client',
				deviceCode: 'neutral-device',
				userCode: 'neutral-code',
				verificationUri: 'https://example.invalid/',
				verificationUrl: 'https://example.invalid/',
				intervalMs: 1000,
				expiresAt: Date.now() + 60_000,
			},
		})
		let respond!: (value: unknown) => void
		poll.mockImplementation(
			() =>
				new Promise((resolve) => {
					respond = resolve
				}),
		)
		await f.service.initializeProviderFromStoredAuth()
		await vi.advanceTimersByTimeAsync(1000)
		expect(poll).toHaveBeenCalledOnce()
		f.scope.close()
		f.service.onunload()
		respond({ ok: false, error: { code: 'authorization_pending' } })
		await vi.advanceTimersByTimeAsync(120_000)
		expect(poll).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
		expect(f.save).not.toHaveBeenCalled()
	})

	it('rejects a late model response without replacing stored configuration', async () => {
		const f = fixture()
		Object.assign(f.settings.ai.nutstoreLlmGateway, {
			accessToken: 'test-only-token',
			accessTokenExpiresAt: Date.now() + 120_000,
		})
		let respond!: (response: Response) => void
		fetchMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					respond = resolve
				}),
		)
		const request = f.service.refreshModels()
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
		const rejected = expect(request).rejects.toMatchObject({
			name: 'AbortError',
		})
		f.scope.close()
		respond(
			new Response(
				JSON.stringify({ data: [{ id: 'neutral', name: '中性 model 🌱' }] }),
			),
		)
		await rejected
		expect(f.settings.ai.providers).toEqual({})
	})
})
