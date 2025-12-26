export function isMarkdownPath(path: string) {
	path = path.trim().toLowerCase()
	return path.endsWith('.md') || path.endsWith('.markdown')
}
