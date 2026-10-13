import { afterEach, describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '~/index'
import { ModuleScope } from '~/modules/lifecycle'
import NutstoreLlmGatewayService from './nutstore-llm-gateway.service'

const { createAuthorization, poll, fetchMock } = vi.hoisted(() => ({
	createAuthorization: vi.fn(),
	poll: vi.fn(),
	fetchMock: vi.fn(),
}))
vi.mock('obsidian', () => ({ Notice: class {} }))
vi.mock('~/consts', () => ({
	LLM_GATEWAY_CLIENT_ID: 'neutral-client',
	NUTSTORE_LLM_GATEWAY_PROVIDER_ID: 'gateway',
}))
vi.mock('@nutstore/sso-js', () => ({
	LlmGatewayClient: class {
		createDeviceAuthorization = createAuthorization
		pollDeviceToken = poll
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
	const settings = { ai: { nutstoreLlmGateway: {}, providers: {} } }
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
