const TEXT_EXTENSIONS = new Set([
	'c',
	'cc',
	'conf',
	'cpp',
	'cs',
	'css',
	'csv',
	'cts',
	'env',
	'fish',
	'go',
	'gql',
	'graphql',
	'h',
	'hpp',
	'htm',
	'html',
	'ini',
	'java',
	'js',
	'json',
	'jsonc',
	'jsx',
	'kt',
	'kts',
	'less',
	'log',
	'markdown',
	'md',
	'mjs',
	'mts',
	'php',
	'properties',
	'ps1',
	'py',
	'rb',
	'rs',
	'sass',
	'scss',
	'sh',
	'sql',
	'svelte',
	'svg',
	'swift',
	'text',
	'toml',
	'ts',
	'tsv',
	'tsx',
	'txt',
	'vue',
	'xml',
	'yaml',
	'yml',
	'zsh',
])

const TEXT_FILENAMES = new Set(['dockerfile', 'license', 'makefile', 'readme'])

export function isMergeablePath(path: string): boolean {
	const filename = path.trim().toLowerCase().split('/').pop() ?? ''
	if (TEXT_FILENAMES.has(filename)) {
		return true
	}

	const extensionIndex = filename.lastIndexOf('.')
	if (extensionIndex < 0) {
		return false
	}

	return TEXT_EXTENSIONS.has(filename.slice(extensionIndex + 1))
}
