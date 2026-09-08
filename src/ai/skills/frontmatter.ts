import { parseYaml } from 'obsidian'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/**
 * Extract and parse the YAML frontmatter at the top of a Markdown file.
 * Returns `undefined` when the file has no frontmatter block. Both the Skill
 * repository (name/description) and the memory index (date/index) route
 * through this single parser.
 *
 * YAML parsing is delegated to `parseYaml` from the Obsidian runtime itself
 * (the same parser the app uses for every note's frontmatter), so this module
 * adds zero dependencies, zero bundle size, and works identically on desktop
 * and mobile.
 */
export function parseYamlFrontmatter(
	content: string,
): Record<string, unknown> | undefined {
	if (typeof content !== 'string' || content.length === 0) {
		return undefined
	}
	const match = FRONTMATTER_PATTERN.exec(content)
	if (!match) return undefined
	return parseYaml(match[1]) as Record<string, unknown>
}
