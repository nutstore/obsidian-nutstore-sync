import { isMarkdownPath } from './is_markdown_path'

export function isMergeablePath(path: string): boolean {
	return isMarkdownPath(path)
}
