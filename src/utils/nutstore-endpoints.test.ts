import { describe, expect, it } from 'vitest'
import {
	NutstoreBaseUrlValidationError,
	isValidNutstoreBaseUrl,
	normalizeNutstoreBaseUrl,
} from './nutstore-endpoints'

function expectValidationReason(
	input: string,
	reason: NutstoreBaseUrlValidationError['reason'],
) {
	try {
		normalizeNutstoreBaseUrl(input)
		throw new Error(`Expected "${input}" to be rejected`)
	} catch (error) {
		expect(error).toBeInstanceOf(NutstoreBaseUrlValidationError)
		expect((error as NutstoreBaseUrlValidationError).reason).toBe(reason)
	}
}

describe('normalizeNutstoreBaseUrl', () => {
	it.each([
		['dav.jianguoyun.com', 'https://dav.jianguoyun.com'],
		['sync.dav.jianguoyun.com', 'https://sync.dav.jianguoyun.com'],
		['dav-server.jianguoyun.com', 'https://dav-server.jianguoyun.com'],
		['DAV.JIANGUOYUN.COM', 'https://dav.jianguoyun.com'],
		['dav123.jianguoyun.com', 'https://dav123.jianguoyun.com'],
		['a.b.c.dav.jianguoyun.com', 'https://a.b.c.dav.jianguoyun.com'],
		['dav.jianguoyun.co', 'https://dav.jianguoyun.co'],
		['dav.jianguoyun.com.cn', 'https://dav.jianguoyun.com.cn'],
		['  dav.jianguoyun.com  ', 'https://dav.jianguoyun.com'],
		['\tdav.jianguoyun.com\n', 'https://dav.jianguoyun.com'],
		['\r\nhttps://dav.jianguoyun.com\t', 'https://dav.jianguoyun.com'],
		['dav.jianguoyun.com:8443', 'https://dav.jianguoyun.com:8443'],
		['dav.jianguoyun.com:1', 'https://dav.jianguoyun.com:1'],
		['dav.jianguoyun.com:65535', 'https://dav.jianguoyun.com:65535'],
		['dav.jianguoyun.com/root', 'https://dav.jianguoyun.com/root'],
		['dav.jianguoyun.com/root/', 'https://dav.jianguoyun.com/root'],
		['dav.jianguoyun.com/root/path', 'https://dav.jianguoyun.com/root/path'],
		[
			'dav.jianguoyun.com/root/My Vault',
			'https://dav.jianguoyun.com/root/My%20Vault',
		],
		['dav.jianguoyun.com?token=abc', 'https://dav.jianguoyun.com'],
		['dav.jianguoyun.com#top', 'https://dav.jianguoyun.com'],
		[
			'dav.jianguoyun.com/root?token=abc#top',
			'https://dav.jianguoyun.com/root',
		],
		['localhost', 'https://localhost'],
		['localhost:8443/root', 'https://localhost:8443/root'],
		['LOCALHOST', 'https://localhost'],
		['192.168.1.10', 'https://192.168.1.10'],
		['192.168.1.10:8443/root', 'https://192.168.1.10:8443/root'],
	])('adds https for domain-like input: %s', (input, expected) => {
		expect(normalizeNutstoreBaseUrl(input)).toBe(expected)
	})

	it.each([
		['https://dav.jianguoyun.com', 'https://dav.jianguoyun.com'],
		['http://dav.jianguoyun.com', 'http://dav.jianguoyun.com'],
		['HTTPS://DAV.JIANGUOYUN.COM', 'https://dav.jianguoyun.com'],
		['https://dav.jianguoyun.com:8443', 'https://dav.jianguoyun.com:8443'],
		['https://dav.jianguoyun.com/root', 'https://dav.jianguoyun.com/root'],
		[
			'https://user:pass@dav.jianguoyun.com',
			'https://user:pass@dav.jianguoyun.com',
		],
	])('keeps valid explicit http or https URLs: %s', (input, expected) => {
		expect(normalizeNutstoreBaseUrl(input)).toBe(expected)
	})

	it.each([
		['https://dav.jianguoyun.com/', 'https://dav.jianguoyun.com'],
		['https://dav.jianguoyun.com///', 'https://dav.jianguoyun.com'],
		['https://dav.jianguoyun.com/root/', 'https://dav.jianguoyun.com/root'],
		['https://dav.jianguoyun.com/root//', 'https://dav.jianguoyun.com/root'],
	])(
		'trims trailing slashes from the saved base URL: %s',
		(input, expected) => {
			expect(normalizeNutstoreBaseUrl(input)).toBe(expected)
		},
	)

	it.each([
		['https://dav.jianguoyun.com?token=abc', 'https://dav.jianguoyun.com'],
		['https://dav.jianguoyun.com#top', 'https://dav.jianguoyun.com'],
		[
			'https://dav.jianguoyun.com/root/?token=abc#top',
			'https://dav.jianguoyun.com/root',
		],
		['dav.jianguoyun.com?token=abc', 'https://dav.jianguoyun.com'],
		['dav.jianguoyun.com#top', 'https://dav.jianguoyun.com'],
		[
			'dav.jianguoyun.com/root?token=abc#top',
			'https://dav.jianguoyun.com/root',
		],
	])('removes search and hash parts before saving: %s', (input, expected) => {
		expect(normalizeNutstoreBaseUrl(input)).toBe(expected)
	})

	it.each([
		'ftp://dav.jianguoyun.com',
		'ws://dav.jianguoyun.com',
		'file://dav.jianguoyun.com',
		'mailto://dav.jianguoyun.com',
	])('rejects unsupported protocols with a user-facing reason: %s', (input) => {
		expectValidationReason(input, 'unsupportedProtocol')
	})

	it.each([
		'',
		'   ',
		'dav',
		'dav server.jianguoyun.com',
		'jianguoyun..com',
		'.jianguoyun.com',
		'jianguoyun.com.',
		'-dav.jianguoyun.com',
		'dav-.jianguoyun.com',
		'dav_jianguoyun.com',
		'jianguoyun.com:abc',
		'jianguoyun.com:65536',
		'jianguoyun.com:-1',
		'/dav.jianguoyun.com',
		'@dav.jianguoyun.com',
		'https:/dav.jianguoyun.com',
		'https:dav.jianguoyun.com',
		'dav.jianguoyun.com/ro\tot',
		'dav.jianguoyun.com/ro\not',
		'dav.jianguoyun.com/ro\rot',
		'https://dav.jianguoyun.com/ro\tot',
		'https://dav.jianguoyun.com/ro\not',
		'https://dav.jianguoyun.com/ro\rot',
		'https://dav.jianguoyun.com\n.evil.test',
	])('does not treat invalid bare input as a domain: %s', (input) => {
		expectValidationReason(input, 'invalidFormat')
	})

	it.each([
		['dav.jianguoyun.com', true],
		['https://dav.jianguoyun.com?token=abc#top', true],
		['http://dav.jianguoyun.com/root', true],
		['ftp://dav.jianguoyun.com', false],
		['jianguoyun.com:abc', false],
		['dav', false],
	])('reports validity for %s', (input, expected) => {
		expect(isValidNutstoreBaseUrl(input)).toBe(expected)
	})
})
