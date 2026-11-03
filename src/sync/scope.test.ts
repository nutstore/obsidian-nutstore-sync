import { describe, expect, it } from 'vitest'
import { SyncScope } from './scope'

/** Independent oracle: the plain definition, checked by scanning every root. */
const within = (parent: string, path: string) =>
	parent === '' || parent === path || path.startsWith(`${parent}/`)

const names = ['Notes 笔记🌱', '資料 Archive', 'Section 小节📘', 'x']
const paths = [
	'',
	...names.flatMap((a) => [
		a,
		...names.flatMap((b) => [
			`${a}/${b}`,
			...names.map((c) => `${a}/${b}/${c}`),
		]),
	]),
]

describe('SyncScope protected subtrees', () => {
	it.each([
		[['Notes 笔记🌱/Section 小节📘']],
		[['Notes 笔记🌱/Section 小节📘', 'Notes 笔记🌱']],
		[['Notes 笔记🌱', 'Notes 笔记🌱/Section 小节📘/x', '資料 Archive/x']],
		[['x/x/x', 'x/x', 'x']],
		[['']],
	])('answers like the plain definition for roots %j', (roots) => {
		const scope = new SyncScope()
		roots.forEach((root) => scope.protect(root))
		for (const path of paths) {
			expect(scope.includes(path), `includes ${path}`).toBe(
				!roots.some((root) => within(root, path)),
			)
			expect(scope.allows(path, { subtree: true }), `subtree ${path}`).toBe(
				!roots.some((root) => within(root, path) || within(path, root)),
			)
			expect(scope.allows(path), `plain ${path}`).toBe(
				!roots.some((root) => within(root, path)),
			)
		}
	})

	it('keeps lookups independent of how many paths are protected', () => {
		const scope = new SyncScope()
		const count = 10_000
		const started = performance.now()
		for (let index = 0; index < count; index++) {
			scope.report({
				path: `目录 Folder ${index}🌱/子目录`,
				operation: 'list',
				cause: new Error('Unavailable 暂不可用🌿'),
			})
		}
		for (let index = 0; index < count; index++) {
			expect(scope.allows(`笔记 Note ${index}📘.md`, { subtree: true })).toBe(
				true,
			)
			expect(scope.includes(`目录 Folder ${index}🌱/子目录/文件.md`)).toBe(
				false,
			)
			expect(scope.allows(`目录 Folder ${index}🌱`, { subtree: true })).toBe(
				false,
			)
		}
		// Linear scans over 10 000 roots take several seconds here.
		expect(performance.now() - started).toBeLessThan(1500)
		expect(scope.issues).toHaveLength(count)
	})
})
