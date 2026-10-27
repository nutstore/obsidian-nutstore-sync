import { posix as pathPosix } from 'path-browserify'

/**
 * Characters that Obsidian canonicalizes inside physical Vault paths. Accepting
 * them in virtual paths would let two different paths address one Vault entry.
 */
const NON_CANONICAL_PATH_CHARACTERS = /[\\\0\u00a0\u202f]/

/** Reject characters that the Vault backend would remap into other path text. */
export function assertCanonicalVirtualPathCharacters(inputPath: string) {
	if (NON_CANONICAL_PATH_CHARACTERS.test(inputPath)) {
		throw new Error(
			`EINVAL: virtual path contains a non-canonical character: '${inputPath}'`,
		)
	}
}

/**
 * Virtual paths are absolute POSIX paths with one representation per segment.
 * Unicode is canonicalized because Obsidian normalizes Vault paths to NFC.
 */
export function normalizeVirtualPath(inputPath: string) {
	assertCanonicalVirtualPathCharacters(inputPath)
	return pathPosix.resolve('/', inputPath.normalize('NFC'))
}

export function toRelativePath(path: string) {
	const normalized = normalizeVirtualPath(path)
	return normalized === '/' ? '' : normalized.slice(1)
}
