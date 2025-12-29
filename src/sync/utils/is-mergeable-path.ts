import { isMarkdownPath } from '../../utils/mime/is_markdown_path'

export function isMergeablePath(path: string): boolean {
	return isMarkdownPath(path)
}
