import * as fc from 'fast-check'
import { zipSync } from 'fflate/browser'
import { Bash, InMemoryFs } from 'just-bash/browser'
import { describe, expect, it } from 'vitest'
import { ObsidianVaultFs, ReversibleOpRecorder } from '~/ai/tools/bash/fs'
import {
	createCompressedFileContent,
	decodeReversibleFileSnapshot,
} from '~/ai/chat/messages/reversible-content'
import { archiveCommands } from '~/ai/tools/bash/zip'
import {
	applyNormalizedSettingsPatch,
	parseSettingsWhitelistJson,
	serializeSettingsWhitelist,
} from '~/ai/tools/settings-whitelist'
import { DEFAULT_SETTINGS, type NutstoreSettings } from '~/settings'
import { MemoryVault } from '../harness/memory-vault'
import { simParams } from '../harness/sim-config'

function makeSettingsWithSecrets(): NutstoreSettings {
	return {
		...DEFAULT_SETTINGS,
		account: 'secret-account@example.test',
		credential: 'super-secret-password-token',
		nutstoreEnterpriseBaseUrl: 'https://internal.example.test',
		ai: {
			...DEFAULT_SETTINGS.ai,
			providers: {
				'secret-provider': {
					id: 'secret-provider',
					name: 'Private Provider',
					npm: '@ai-sdk/openai',
					env: [],
					doc: '',
					api: 'https://api.example.test/v1',
					apiKey: 'sk-live-do-not-leak-99999',
					models: {},
				},
			},
		},
	}
}

describe('Red-team security & sandbox fuzzing', () => {
	describe('settings-whitelist attack surface', () => {
		it('never leaks credentials, enterprise URLs, or AI API keys in serialized whitelist', () => {
			const settings = makeSettingsWithSecrets()
			const serialized = serializeSettingsWhitelist(settings)

			expect(serialized).not.toContain('secret-account@example.test')
			expect(serialized).not.toContain('super-secret-password-token')
			expect(serialized).not.toContain('internal.example.test')
			expect(serialized).not.toContain('sk-live-do-not-leak-99999')
			expect(serialized).not.toContain('credential')
			expect(serialized).not.toContain('apiKey')
			expect(serialized).not.toContain('oauth')

			// Round-trip of serialized output must always parse cleanly
			const reparsed = parseSettingsWhitelistJson(serialized)
			expect(reparsed.ok).toBe(true)
		})

		it('rejects credential overwrite attempts and prototype pollution payloads', () => {
			const attacks = [
				'{"__proto__": {"polluted": true}}',
				'{"constructor": {"prototype": {"polluted": true}}}',
				'{"prototype": {"polluted": true}}',
				'{"account": "attacker@example.test"}',
				'{"credential": "stolen"}',
				'{"oauthResponse": {"accessToken": "evil"}}',
				'{"nutstoreEnterpriseBaseUrl": "https://evil.example.test"}',
				'{"ai": {"providers": {}}}',
				'{"remoteDir": "/stolen"}',
				'{"language": "en", "__proto__": {"polluted": true}}',
				'{"language": "en", "credential": "override"}',
			]

			for (const payload of attacks) {
				const result = parseSettingsWhitelistJson(payload)
				expect(result.ok).toBe(false)
			}

			// Nested __proto__ inside allowed objects must never pollute Object.prototype
			const nestedAttacks = [
				'{"skipLargeFiles": {"maxSize": "10MB", "__proto__": {"polluted": true}}}',
				'{"filterRules": {"rules": [{"expr": "*.md", "type": "exclude", "__proto__": {"polluted": true}}]}}',
			]
			const settings = makeSettingsWithSecrets()
			for (const payload of nestedAttacks) {
				const result = parseSettingsWhitelistJson(payload)
				if (result.ok) {
					applyNormalizedSettingsPatch(settings, result.patch)
				}
			}

			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
			expect(Object.prototype).not.toHaveProperty('polluted')
			expect(settings.credential).toBe('super-secret-password-token')
			expect(settings.account).toBe('secret-account@example.test')
		})

		it('never crashes on fuzzed JSON & type confusion and preserves untouched secrets', () => {
			const settings = makeSettingsWithSecrets()
			const originalCredential = settings.credential
			const originalAccount = settings.account
			const originalApiKey = settings.ai.providers['secret-provider'].apiKey

			fc.assert(
				fc.property(
					fc.oneof(
						fc.string({ maxLength: 200 }),
						fc.jsonValue().map((value) => JSON.stringify(value)),
					),
					(rawInput) => {
						const res = parseSettingsWhitelistJson(rawInput)
						expect(typeof res.ok).toBe('boolean')
						if (res.ok) {
							applyNormalizedSettingsPatch(settings, res.patch)
							expect(settings.credential).toBe(originalCredential)
							expect(settings.account).toBe(originalAccount)
							expect(settings.ai.providers['secret-provider'].apiKey).toBe(
								originalApiKey,
							)
							if (res.patch.startupSyncDelaySeconds !== undefined) {
								expect(
									res.patch.startupSyncDelaySeconds,
								).toBeGreaterThanOrEqual(0)
								expect(res.patch.startupSyncDelaySeconds).toBeLessThanOrEqual(
									86400,
								)
							}
							if (res.patch.autoSyncIntervalSeconds !== undefined) {
								expect(
									res.patch.autoSyncIntervalSeconds,
								).toBeGreaterThanOrEqual(0)
								expect(res.patch.autoSyncIntervalSeconds).toBeLessThanOrEqual(
									86400,
								)
							}
						} else {
							expect(typeof res.error).toBe('string')
							expect(res.error.length).toBeGreaterThan(0)
						}
					},
				),
				simParams(120, 301),
			)
		})
	})

	describe('zip / unzip Zip Slip & decompression bomb defense', () => {
		it('rejects Zip Slip traversal payloads without writing outside destination', async () => {
			const evilEntryNames = [
				'../escape.md',
				'../../outside/pwn.md',
				'sub/../../escape.md',
				'/etc/passwd',
				'foo\\..\\bar.md',
				'dir//file.md',
			]

			for (const evilName of evilEntryNames) {
				const fs = new InMemoryFs()
				await fs.mkdir('/work/extract', { recursive: true })
				const archiveBytes = zipSync({
					[evilName]: new TextEncoder().encode('malicious payload / 恶意负载'),
				})
				await fs.writeFile('/work/evil.zip', archiveBytes)

				const bash = new Bash({
					fs,
					cwd: '/work',
					customCommands: archiveCommands,
				})
				const res = await bash.exec('unzip evil.zip -d /work/extract')
				expect(res.exitCode).not.toBe(0)
				expect(res.stderr).toMatch(/unsafe archive entry/i)
				expect(await fs.exists('/work/escape.md')).toBe(false)
				expect(await fs.exists('/escape.md')).toBe(false)
				expect(await fs.exists('/etc/passwd')).toBe(false)
			}
		})

		it('rejects archives exceeding decompression size limits', async () => {
			const fs = new InMemoryFs()
			await fs.mkdir('/work/out', { recursive: true })
			// Highly compressible repeated data that inflates past maxOutputSize
			const big = new Uint8Array(256 * 1024).fill(65)
			await fs.writeFile('/work/bomb.zip', zipSync({ 'huge.txt': big }))

			const bash = new Bash({
				fs,
				cwd: '/work',
				customCommands: archiveCommands,
				executionLimits: { maxOutputSize: 4096 },
			})
			const res = await bash.exec('unzip bomb.zip -d /work/out')
			expect(res.exitCode).not.toBe(0)
			expect(res.stderr).toMatch(/exceeds limit/i)
			expect(await fs.exists('/work/out/huge.txt')).toBe(false)
		})

		it('round-trips Unicode/CJK/Emoji zip entries safely', async () => {
			const fs = new InMemoryFs()
			await fs.mkdir('/src/文档🌱', { recursive: true })
			const payload = 'Neutral zip content / 中性压缩内容 🌿\nLine 2 🛠️'
			await fs.writeFile('/src/文档🌱/示例.md', payload)

			const bash = new Bash({
				fs,
				cwd: '/src',
				customCommands: archiveCommands,
			})
			const zipRes = await bash.exec('zip -r /bundle.zip 文档🌱')
			expect(zipRes.exitCode).toBe(0)

			const unzipRes = await bash.exec('unzip /bundle.zip -d /restored')
			expect(unzipRes.exitCode).toBe(0)
			expect(await fs.readFile('/restored/文档🌱/示例.md')).toBe(payload)
		})
	})

	describe('ObsidianVaultFs read-only isolation & rollback consistency', () => {
		it('refuses every mutating operation on host-owned read-only paths before side effects', async () => {
			const vault = new MemoryVault()
			vault.seedFile('.agents/apps/demo/manifest.json', '{"id":"demo"}')
			vault.seedFile('notes/normal.md', 'hello')
			vault.clearMutations()

			const fs = new ObsidianVaultFs(
				vault.app as never,
				[],
				undefined,
				undefined,
				{
					readOnlyPath: (vaultPath) =>
						vaultPath === '.agents/apps/demo/manifest.json' ||
						vaultPath.startsWith('.agents/apps/demo/'),
				},
			)

			await expect(
				fs.writeFile('/.agents/apps/demo/manifest.json', '{"hacked":true}'),
			).rejects.toThrow(/EROFS/)
			await expect(
				fs.appendFile('/.agents/apps/demo/manifest.json', 'x'),
			).rejects.toThrow(/EROFS/)
			await expect(fs.rm('/.agents/apps/demo/manifest.json')).rejects.toThrow(
				/EROFS/,
			)
			await expect(
				fs.mv('/.agents/apps/demo/manifest.json', '/notes/moved.json'),
			).rejects.toThrow(/EROFS/)
			await expect(
				fs.mv('/notes/normal.md', '/.agents/apps/demo/manifest.json'),
			).rejects.toThrow(/EROFS/)

			// Zero mutations must have leaked to the underlying vault
			expect(vault.mutations).toHaveLength(0)
			expect(vault.readTextDirect('.agents/apps/demo/manifest.json')).toBe(
				'{"id":"demo"}',
			)
		})

		it('computes minimal exact net operations in ReversibleOpRecorder across random edit sequences', async () => {
			const filePaths = ['a.md', 'dir/笔记🌱.md', 'dir/sub/data.json']
			const opArb = fc.oneof(
				fc.record({
					kind: fc.constant('write' as const),
					path: fc.constantFrom(...filePaths),
					content: fc.constantFrom('v1', 'v2 中文', 'v3 🌱', 'v1'),
				}),
				fc.record({
					kind: fc.constant('delete' as const),
					path: fc.constantFrom(...filePaths),
				}),
			)

			await fc.assert(
				fc.asyncProperty(
					fc.array(opArb, { minLength: 1, maxLength: 10 }),
					async (ops) => {
						const initial = new Map<string, string>([
							['a.md', 'v1'],
							['dir/笔记🌱.md', 'initial 中文'],
						])
						const current = new Map(initial)
						const recorder = new ReversibleOpRecorder()

						const snapshotOf = (value: string | undefined) =>
							value === undefined
								? undefined
								: {
										kind: 'file' as const,
										contentCompressed: createCompressedFileContent(value),
									}

						for (const op of ops) {
							const before = current.get(op.path)
							if (op.kind === 'write') {
								current.set(op.path, op.content)
								recorder.recordVirtualTransition(
									op.path,
									snapshotOf(before),
									snapshotOf(op.content),
								)
							} else {
								current.delete(op.path)
								recorder.recordVirtualTransition(
									op.path,
									snapshotOf(before),
									undefined,
								)
							}
						}

						const netOps = await recorder.getNetOperations()
						const textDecoder = new TextDecoder('utf-8')
						// Reversing netOps from `current` must exactly reconstruct `initial`
						const reverted = new Map(current)
						for (const net of netOps) {
							if (net.operation === 'create') {
								reverted.delete(net.vaultPath)
							} else if (
								net.operation === 'delete' ||
								net.operation === 'update'
							) {
								if (net.before.kind === 'file') {
									const buf = await decodeReversibleFileSnapshot(net.before)
									reverted.set(net.vaultPath, textDecoder.decode(buf))
								}
							}
						}
						expect(reverted).toEqual(initial)
					},
				),
				simParams(60, 302),
			)
		})
	})
})
