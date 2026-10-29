import { describe, expect, it } from 'vitest'
import { resolveByIntelligentMerge } from './merge-utils'

const article =
	'# Guide 指南 🌿\n\n第一段：共享说明。\n\nSecond paragraph: shared notes.\n'

async function merge(
	base: string,
	local: string,
	remote: string,
	hasBase = true,
) {
	const result = await resolveByIntelligentMerge({
		baseContentText: base,
		localContentText: local,
		remoteContentText: remote,
		hasBase,
		filePath: 'Guide 指南 🌿.md',
	})
	expect(result.success).toBe(true)
	return result.isIdentical ? local : result.mergedText!
}

describe('shared insertions in automatic text merge', () => {
	it.each(['Observation', '共同观察', 'Observation 共同观察 🌱'])(
		'keeps repeated baseline lines without adding another copy (%s)',
		async (line) => {
			const lines = Array<string>(5).fill(line)
			const localLines = [...lines]
			const remoteLines = [...lines]
			localLines[0] += ' Local supplement 本地补充 🌿'
			remoteLines[1] += ' Remote supplement 远程补充 🧭'
			const expected = [...lines]
			expected[0] = localLines[0]
			expected[1] = remoteLines[1]
			expect(
				await merge(
					lines.join('\n') + '\n',
					localLines.join('\n') + '\n',
					remoteLines.join('\n') + '\n',
				),
			).toBe(expected.join('\n') + '\n')
		},
	)

	it.each([
		[
			'code blocks',
			'```text\nLocal example 本地示例 🌿\n```\n',
			'```text\nRemote example 远程示例 🧭\n```\n',
		],
		[
			'lists',
			'- Shared checklist item / 共同检查项 🌱\n- Local item 本地事项 🌿\n',
			'- Shared checklist item / 共同检查项 🌱\n- Remote item 远程事项 🧭\n',
		],
		[
			'blank lines',
			'Local observation 本地观察 🌿\n\nLocal conclusion 本地结论 🌱\n',
			'Remote observation 远程观察 🧭\n\nRemote conclusion 远程结论 🌳\n',
		],
	])(
		'keeps independent sections with %s intact',
		async (_name, localBody, remoteBody) => {
			const localSection = '## Local section 本地章节 🌿\n\n' + localBody
			const remoteSection = '## Remote section 远程章节 🧭\n\n' + remoteBody
			for (const base of ['', '# Outline 提纲 🌱\n\n']) {
				for (const [left, right] of [
					[localSection, remoteSection],
					[remoteSection, localSection],
				]) {
					const result = await merge(
						base,
						base + left,
						base + right,
						base !== '',
					)
					expect([base + left + right, base + right + left]).toContain(result)
				}
			}
		},
	)

	it('keeps independent sections intact inside an otherwise shared article', async () => {
		const shared =
			article +
			'Observation / 观察：记录植物在不同季节的生长变化 🌱\n' +
			'Method / 方法：每次观察使用相同的记录格式 🧭\n'
		const local =
			'## Local section 本地章节 🌿\n\n- Shared checklist item / 共同检查项 🌱\n- Local detail 本地细节\n'
		const remote =
			'## Remote section 远程章节 🧭\n\n- Shared checklist item / 共同检查项 🌱\n- Remote detail 远程细节\n'
		const result = await merge('', shared + local, shared + remote, false)
		expect([shared + local + remote, shared + remote + local]).toContain(result)
	})

	it('does not treat a minority of shared prose as a shared article', async () => {
		const common = 'Shared observation / 共同观察：植物需要适量的水分 🌱\n'
		const local =
			'Local introduction / 本地引言：记录不同环境下的观察结果 🌿\n' +
			common +
			'Local conclusion / 本地结论：下一次观察应保持环境条件稳定 🌳\n'
		const remote =
			'Remote introduction / 远程引言：整理不同季节里的记录内容 🧭\n' +
			common +
			'Remote conclusion / 远程结论：后续记录应补充温度变化情况 🌻\n'
		const result = await merge('', local, remote, false)
		expect([local + remote, remote + local]).toContain(result)
	})

	it.each([
		[
			'```text\nLocal example 本地示例 🌿\n```\n',
			'```text\nRemote example 远程示例 🧭\n```\n',
		],
		[
			'- Shared checklist item / 共同检查项 🌱\n- Local detail 本地细节 🌿\n',
			'- Shared checklist item / 共同检查项 🌱\n- Remote detail 远程细节 🧭\n',
		],
	])(
		'keeps independently changed blocks intact under a shared heading',
		async (local, remote) => {
			const result = await merge('', article + local, article + remote, false)
			expect([article + local + remote, article + remote + local]).toContain(
				result,
			)
		},
	)

	it('does not infer a shared article from reordered prose', async () => {
		const first = 'First observation / 第一项观察：保持适量的水分 🌿\n'
		const second = 'Second observation / 第二项观察：保持稳定的温度 🧭\n'
		const third = 'Third observation / 第三项观察：保持充足的光照 🌱\n'
		const local = first + second + third
		const remote = third + second + first
		expect([local + remote, remote + local]).toContain(
			await merge('', local, remote, false),
		)
	})

	it.each(['---', '==='])(
		'scopes underlined headings (%s) separately',
		async (underline) => {
			const common = 'Shared observation / 共同观察：记录植物的生长状态 🌱\n'
			const local = `Local section 本地章节 🌿\n${underline}\n` + common
			const remote = `Remote section 远程章节 🧭\n${underline}\n` + common
			const shared = article + 'Method / 方法：每次观察使用相同的记录格式 🧭\n'
			const result = await merge('', shared + local, shared + remote, false)
			expect([shared + local + remote, shared + remote + local]).toContain(
				result,
			)
		},
	)

	it('shares fenced blocks and lists across line-ending changes', async () => {
		const local =
			article +
			'```text\nExample 示例 🌱\n```\n\n- Checklist 检查项 🧭\n- Observation 观察项 🌿\n'
		const remote = local.replaceAll('\n', '\r\n')
		expect(
			(await merge('', local, remote, false)).replaceAll('\r\n', '\n'),
		).toBe(local)
	})

	it.each([
		['missing baseline', '', false],
		['empty baseline', '', true],
		['older outline', '# Outline 提纲 🧭\n\n', true],
	] as const)(
		'%s retains one article and both edits',
		async (_name, base, hasBase) => {
			const localAddition = 'Local supplement / 本地补充 🧭\n'
			const remoteAddition = 'Remote supplement / 远程补充 🌱\n'
			const local =
				base +
				article.replace(
					'第一段：共享说明。\n',
					'第一段：共享说明。\n' + localAddition,
				)
			const remote = base + article + remoteAddition
			const expected = local + remoteAddition
			for (let attempt = 0; attempt < 10; attempt++) {
				expect(await merge(base, local, remote, hasBase)).toBe(expected)
			}
		},
	)

	it.each([
		['trailing newline', article.trimEnd()],
		['line endings', article.replaceAll('\n', '\r\n')],
	])(
		'%s cannot duplicate an article without a baseline',
		async (_name, remote) => {
			const result = await merge('', article, remote, false)
			expect(result.replaceAll('\r\n', '\n').trimEnd()).toBe(article.trimEnd())
		},
	)

	it('shares unchanged lines while retaining both versions of a changed line', async () => {
		const remote = article.replace('共享说明', '远程补充说明')
		const result = await merge('', article, remote, false)
		expect(result.split('# Guide 指南 🌿')).toHaveLength(2)
		expect(result.split('Second paragraph: shared notes.')).toHaveLength(2)
		expect(result).toContain('第一段：共享说明。\n')
		expect(result).toContain('第一段：远程补充说明。\n')
	})

	it('keeps intentional repeated paragraphs in newly inserted text', async () => {
		const repeated = '重复说明 / Repeated note 🌿\n\n'
		const local = article + repeated + repeated
		const remote = local + 'Remote supplement / 远程补充 🧭\n'
		expect(await merge('', local, remote, false)).toBe(remote)
	})

	it('does not collapse equal text inserted at different baseline positions', async () => {
		const base =
			'# Guide 指南 🌿\n\nFirst section 第一节\n\nLast section 末节\n'
		const addition = 'Repeated note 重复说明 🧭\n'
		const local = addition + base
		const remote = base + addition
		expect(await merge(base, local, remote)).toBe(addition + base + addition)
	})

	it('retains unrelated concurrent paragraphs with similar words', async () => {
		const local = 'Local observation / 本地观察 🌿\n'
		const remote = 'Remote observation / 远程观察 🧭\n'
		const result = await merge('', local, remote, false)
		expect(result).toContain(local)
		expect(result).toContain(remote)
	})

	it('shares the same inserted phrase when another edit also changes the line', async () => {
		expect(
			await merge(
				'今天整理笔记。🌿',
				'今天上午整理笔记。🌿',
				'今天上午整理读书笔记。🌿',
			),
		).toBe('今天上午整理读书笔记。🌿')
	})

	it('does not append another article when a remote write is retried', async () => {
		const base = '# Outline 提纲 🧭\n\n'
		const local = base + article
		const remote = local + 'Remote supplement / 远程补充 🧭\n'
		const first = await merge(base, local, remote)
		expect(first).toBe(remote)
		expect(await merge(base, local, first)).toBe(first)
		expect(await merge(base, first, remote)).toBe(first)
	})

	it('preserves generated multilingual articles, both edits, and retries', async () => {
		const labels = [
			'Section / Note',
			'章节 / 说明',
			'Section 章节 🌿 / Note 说明 🧭',
		]
		for (const label of labels) {
			for (const size of [4, 16, 64, 256]) {
				const lines = Array.from(
					{ length: size },
					(_, index) => `${label} ${index}\n`,
				)
				const localAddition = 'Local supplement / 本地补充 🌱\n'
				const remoteAddition = 'Remote supplement / 远程补充 🧭\n'
				const localLines = [
					...lines.slice(0, 1),
					localAddition,
					...lines.slice(1),
				]
				const remoteLines = [
					...lines.slice(0, size - 1),
					remoteAddition,
					...lines.slice(size - 1),
				]
				const expectedLines = [
					...localLines.slice(0, size),
					remoteAddition,
					...localLines.slice(size),
				]
				for (const base of ['', '# Outline 提纲 🌿\n\n']) {
					const local = base + localLines.join('')
					const remote = base + remoteLines.join('')
					const expected = base + expectedLines.join('')
					const result = await merge(base, local, remote, base !== '')
					expect(result).toBe(expected)
					expect(await merge(base, remote, local, base !== '')).toBe(expected)
					expect(await merge(base, local, result, base !== '')).toBe(expected)
				}
			}
		}
	})
})
