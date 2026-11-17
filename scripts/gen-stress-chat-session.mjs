#!/usr/bin/env node
/**
 * Generates a deliberately huge chat session snapshot for load/render stress
 * testing: one very long master timeline plus a large number of `apply_patch`
 * tool calls, each backed by real reversible ops (deflate-compressed before and
 * after snapshots), tool timings, and workspace-context deltas.
 *
 * The output mirrors what the plugin itself writes, so it can be dropped into
 * `.agents/nutstore-sync/sessions/<id>.json` and opened from the chat list.
 * Every generated fixture is neutral abstract content (zh/en/emoji) — no real
 * notes, paths, or people.
 *
 * Usage:
 *   node scripts/gen-stress-chat-session.mjs --vault <vault-root> \
 *     [--turns 400] [--patch-min 3] [--patch-max 7] [--seed 20260101] \
 *     [--mega 3] [--mega-chars 88000] [--oversized 1] \
 *     [--giant-bash 2] [--giant-bash-kb 900] [--giant-prompt 2] \
 *     [--subagents 0] \
 *     [--id session_stress-long-patch] [--title "压力测试…"] [--no-meta]
 *
 * `--mega` adds a handful of giant patches whose before/after snapshots stay
 * under the diff budget (200k chars) so the full line diff really runs, while
 * `--oversized` adds patches beyond that budget to exercise the summarized
 * path. Both keep the patch payload itself thousands of lines long.
 */
import { randomUUID, randomInt } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const SESSIONS_DIR = join('.agents', 'nutstore-sync', 'sessions')
const META_PATH = join('.agents', 'nutstore-sync', 'chat-meta.json')
/** Mirrors MAX_DIFF_TEXT_CHARS in src/ai/chat/messages/file-diff.ts. */
const DIFF_TEXT_BUDGET = 200_000
/**
 * A mega rewrite adds roughly its own size again on the "after" side, so the
 * before snapshot must stay under this fraction of the budget to exercise the
 * real line diff instead of the summarized oversized path.
 */
const MEGA_CHARS_CEILING = Math.floor(DIFF_TEXT_BUDGET / 2.2)
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/**
 * Fixtures must never reference a real provider or model: they would otherwise
 * look like selectable state and leak current model naming into the vault.
 */
const FIXTURE_PROVIDER = {
	providerId: 'fixture-provider',
	providerName: 'Fixture Provider',
}
const FIXTURE_MODEL = {
	modelId: 'fixture/long-context-mock',
	modelName: 'Fixture Mock Model',
}

function parseArgs(argv) {
	const args = {
		vault: undefined,
		turns: 400,
		patchMin: 3,
		patchMax: 7,
		seed: 20260101,
		mega: 3,
		megaChars: 88_000,
		oversized: 1,
		giantBash: 2,
		giantBashKb: 900,
		giantPrompt: 2,
		subagents: 0,
		id: 'session_stress-long-patch',
		title: '压力测试：超长对话与海量补丁',
		meta: true,
	}
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]
		if (!token.startsWith('--')) continue
		const key = token.slice(2)
		if (key === 'no-meta') {
			args.meta = false
			continue
		}
		const value = argv[i + 1]
		i += 1
		if (key === 'vault') args.vault = value
		else if (key === 'turns') args.turns = Number(value)
		else if (key === 'patch-min') args.patchMin = Number(value)
		else if (key === 'patch-max') args.patchMax = Number(value)
		else if (key === 'seed') args.seed = Number(value)
		else if (key === 'mega') args.mega = Number(value)
		else if (key === 'mega-chars') args.megaChars = Number(value)
		else if (key === 'oversized') args.oversized = Number(value)
		else if (key === 'giant-bash') args.giantBash = Number(value)
		else if (key === 'giant-bash-kb') args.giantBashKb = Number(value)
		else if (key === 'giant-prompt') args.giantPrompt = Number(value)
		else if (key === 'subagents') args.subagents = Number(value)
		else if (key === 'id') args.id = value
		else if (key === 'title') args.title = value
		else throw new Error(`Unknown flag: ${token}`)
	}
	if (!args.vault) throw new Error('Missing --vault <vault-root>')
	if (args.patchMin < 1 || args.patchMax < args.patchMin)
		throw new Error('patch bounds are invalid')
	if (args.megaChars < 1000) throw new Error('--mega-chars is too small')
	args.megaCharsClamped = args.megaChars > MEGA_CHARS_CEILING
	args.megaChars = Math.min(args.megaChars, MEGA_CHARS_CEILING)
	return args
}

/** Deterministic PRNG so a stress fixture can be reproduced byte for byte. */
function createRandom(seed) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function createGenerator(random) {
	const pick = (list) => list[Math.floor(random() * list.length)]
	const pickInt = (min, max) => min + Math.floor(random() * (max - min + 1))
	const slug = (length) => {
		let out = ''
		for (let i = 0; i < length; i += 1)
			out += BASE62[Math.floor(random() * BASE62.length)]
		return out
	}
	return { pick, pickInt, slug }
}

/** Message ids in the plugin are `message-<uuidv7>`; keep the same shape. */
function messageId(ms) {
	return `message-${uuidv7(ms)}`
}

function uuidv7(ms) {
	const hex = Math.floor(ms).toString(16).padStart(12, '0')
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`7${randomInt(0, 0xfff).toString(16).padStart(3, '0')}`,
		`${randomInt(0x8, 0xb).toString(16)}${randomInt(0, 0xfff).toString(16).padStart(3, '0')}`,
		randomUUID().replaceAll('-', '').slice(12, 24),
	].join('-')
}

function toolCallId(random) {
	const { slug } = createGenerator(random)
	return `call_${slug(24)}`
}

function compressedFile(text) {
	return {
		kind: 'file',
		contentCompressed: {
			compress: 'deflate',
			blob: {
				__nutstore_chat_blob_v2: true,
				type: 'application/octet-stream',
				data: deflateRawSync(Buffer.from(text, 'utf8')).toString('base64url'),
			},
		},
	}
}

const TOPICS = [
	{
		zh: '整理归档目录',
		en: 'organize the archive directory',
		emoji: '🗂️',
	},
	{ zh: '对齐章节编号', en: 'align chapter numbering', emoji: '🔢' },
	{ zh: '校验链接引用', en: 'verify link references', emoji: '🔗' },
	{ zh: '合并重复条目', en: 'merge duplicated entries', emoji: '🧬' },
	{ zh: '重写表格排版', en: 'rewrite table layout', emoji: '📊' },
	{ zh: '拆分长段落', en: 'split long paragraphs', emoji: '✂️' },
	{ zh: '补齐元数据', en: 'fill in metadata fields', emoji: '🏷️' },
	{ zh: '统一术语用词', en: 'unify terminology', emoji: '📖' },
	{ zh: '生成目录索引', en: 'generate a table of contents', emoji: '🧭' },
	{ zh: '修正缩进层级', en: 'fix indentation depth', emoji: '↔️' },
]

const FOLDER_STEMS = [
	['🧪 压力实验室', 'stress-lab'],
	['📚 样例文档', 'sample-docs'],
	['🗄️ 归档区', 'archive'],
	['📋 项目草稿', 'project-drafts'],
]

const NOTE_STEMS = [
	['会议纪要', 'meeting-notes'],
	['设计草案', 'design-draft'],
	['术语表', 'glossary'],
	['发布清单', 'release-checklist'],
	['实验记录', 'experiment-log'],
]

const CONTEXT_LINES = [
	'## 背景与目标',
	'本节记录可复现的步骤，便于后续核对。',
	'| 编号 | 说明 | 状态 |',
	'| --- | --- | --- |',
	'| 001 | 初始化工作区 | 完成 |',
	'| 002 | 采集样本数据 | 进行中 |',
	'',
	'Notes are kept short so each line stays diffable.',
	'前置条件：本地环境已就绪，无需额外依赖。',
	'- 步骤一：读取输入，检查边界条件。',
	'- 步骤二：应用变更，记录差异。',
	'- 步骤三：复核结果，写回摘要。',
	'Emoji 混排示例：🧪 ✅ 🚧 🌱 🔍',
	'中英混排示例：先 run 一次 dry-run，再 apply 变更。',
	'> 引用块用于说明例外情况。',
	'```text',
	'keep this code block stable across patches',
	'```',
]

const INSERT_LINES = [
	'+ 新增说明：变更仅影响展示层，不影响数据语义。',
	'+ Added a note that the change only touches presentation.',
	'+ 补充边界条件：空目录、同名文件、超长路径。',
	'+ 校验通过后写入，失败时回滚到上一版本。',
	'+ Emoji 补丁行：✅ 🚧 🔍',
	'+ 术语统一为“同步策略”，避免同义反复。',
	'+ Register the new entry in the index table.',
	'+ 索引表登记：001 / 002 / 003。',
]

const DELETE_LINES = [
	'- 旧说明：该段落已被新版本取代。',
	'- Removed a stale paragraph that duplicated the section above.',
	'- 旧标题层级过深，已合并至上一级。',
	'- 旧步骤缺少校验，已删除。',
	'- 冗余示例：🔁 重复内容。',
]

const REASONING_ZH = [
	'先看当前文件的整体结构，再决定补丁的切分方式。',
	'需要确认上一轮补丁是否真的落盘，避免重复修改。',
	'本次变更涉及中英混排与 emoji，注意按行对齐，不要破坏表格。',
	'按最小改动原则，一次只调整一层缩进。',
	'先读取清单，再逐条应用；保持顺序稳定。',
	'校验失败时应当可以回滚，所以先记录快照。',
]

const REASONING_EN = [
	'Read the target file first, then split the patch into small hunks.',
	'Confirm the previous patch landed before touching the same region.',
	'Keep the change minimal: one indentation level per patch.',
	'Record a snapshot so the operation stays reversible.',
	'Verify the mixed zh/en/emoji lines still align after the edit.',
]

const SUMMARIES = [
	'已完成本轮修改：调整了结构、补齐了说明，并保留了可回滚快照。',
	'本轮共应用 {n} 个补丁，全部通过一致性检查。',
	'Applied {n} patches; each snapshot stays reversible.',
	'已更新术语与表格，中文、英文与 emoji 行均按预期对齐。',
	'变更已写入并复核，下一步等待反馈。',
	'Patch batch {n} finished; no residual markers left behind.',
]

const BASH_SCRIPTS = [
	{ purpose: '查看目录结构', script: 'ls -la /🧪 压力实验室' },
	{ purpose: '统计文件行数', script: 'wc -l /📚 样例文档/*.md' },
	{
		purpose: '检索重复标题',
		script: 'grep -rn "^## " /🗄️ 归档区 | sort | uniq -c',
	},
	{
		purpose: 'inspect the working tree',
		script: 'find /📋 项目草稿 -name "*.md" | head -40',
	},
]

function noteContent({ index, folder, stem, random }) {
	const lines = [
		'---',
		`title: ${stem[0]} ${String(index).padStart(4, '0')}`,
		'tags: [样例, sample, 🧪]',
		'---',
		'',
		`# ${stem[0]} ${String(index).padStart(4, '0')} ${folder[0]}`,
		'',
	]
	const count = 24 + Math.floor(random() * 40)
	for (let i = 0; i < count; i += 1) {
		lines.push(CONTEXT_LINES[Math.floor(random() * CONTEXT_LINES.length)])
	}
	return `${lines.join('\n')}\n`
}

function buildPatch({ path, random }) {
	const hunkCount = 1 + Math.floor(random() * 3)
	const parts = ['*** Begin Patch', `*** Update File: ${path}`]
	for (let h = 0; h < hunkCount; h += 1) {
		parts.push('@@')
		const contextCount = 2 + Math.floor(random() * 3)
		for (let c = 0; c < contextCount; c += 1)
			parts.push(
				` ${CONTEXT_LINES[Math.floor(random() * CONTEXT_LINES.length)]}`,
			)
		const deletes = Math.floor(random() * 2)
		for (let d = 0; d < deletes; d += 1)
			parts.push(DELETE_LINES[Math.floor(random() * DELETE_LINES.length)])
		const inserts = 1 + Math.floor(random() * 2)
		for (let i = 0; i < inserts; i += 1)
			parts.push(INSERT_LINES[Math.floor(random() * INSERT_LINES.length)])
	}
	parts.push('*** End Patch')
	return parts.join('\n')
}

/**
 * A large, uniformly structured markdown document. Every section owns a fixed
 * number of lines so a mutation can rewrite a whole section and the emitted
 * hunks stay exactly consistent with the before/after snapshots.
 */
function megaSections(count, random) {
	const heading = ['梳理', '校验', '合并', '整理', '拆分']
	const english = [
		'Review the section boundaries before editing.',
		'Keep zh/en/emoji lines aligned while rewriting.',
		'Each hunk stays small enough to stay reversible.',
		'Record the snapshot so the change can be rolled back.',
	]
	const sections = []
	for (let i = 0; i < count; i += 1) {
		sections.push([
			`## ${String(i + 1).padStart(4, '0')} ${heading[i % heading.length]}`,
			`- 条目说明：${english[i % english.length]}`,
			`- 中英混排：${heading[(i + 1) % heading.length]} / keep aligned`,
			`- Emoji：${['🧪', '✅', '🚧', '🔍', '🌱'][i % 5]} 第 ${i + 1} 节`,
			`- ${english[(i + 2) % english.length]}`,
			'',
		])
	}
	void random
	return sections
}

function renderSections(sections) {
	return sections.flat().join('\n')
}

/**
 * Section counts are derived from a character budget instead of a raw count, so
 * `--mega-chars` maps onto the real diff budget rather than onto an opaque
 * number of sections.
 */
function sectionsForChars(chars, random) {
	const probe = megaSections(20, random)
	const perSection = renderSections(probe).length / probe.length
	return Math.max(20, Math.round(chars / perSection))
}

/** Rewrites the marked sections so the diff has thousands of changed lines. */
function mutateSections(sections, mutateEvery) {
	const after = []
	const changed = new Set()
	for (const [index, lines] of sections.entries()) {
		if (index % mutateEvery === 0) {
			changed.add(index)
			after.push([
				...lines.slice(0, 1),
				`- ✏️ 重写条目 ${index + 1}，原文保留在旧快照中。`,
				`- Rewritten entry ${index + 1}; the previous text lives in the old snapshot.`,
				...lines.slice(2),
			])
		} else {
			after.push(lines)
		}
	}
	return { after, changed }
}

/**
 * Emits a real `apply_patch` payload for the mutated sections: two context
 * lines, the removed section lines, and the rewritten ones. `maxLines` caps the
 * patch text so a single tool call stays in the hundreds of kilobytes.
 */
function buildMegaPatch({ path, sections, mutated, changed, maxLines }) {
	const parts = ['*** Begin Patch', `*** Update File: ${path}`]
	let emitted = 0
	let open = false
	for (let i = 0; i < sections.length && emitted < maxLines; i += 1) {
		if (changed.has(i)) {
			if (!open) {
				parts.push('@@')
				for (let c = Math.max(0, i - 2); c < i; c += 1) {
					for (const line of sections[c]) {
						parts.push(` ${line}`)
						emitted += 1
					}
				}
				open = true
			}
			for (const line of sections[i]) {
				parts.push(`-${line}`)
				emitted += 1
			}
			for (const line of mutated[i]) {
				parts.push(`+${line}`)
				emitted += 1
			}
		} else if (open) {
			parts.push(...sections[i].map((line) => ` ${line}`))
			emitted += sections[i].length
		}
	}
	parts.push('*** End Patch')
	return parts.join('\n')
}

/**
 * Grapheme clusters that stress wrapping, font fallback and surrogate handling:
 * ZWJ sequences, flags, RTL, stacked combining marks, CJK ext-B, zero widths.
 */
const TRICKY_TEXT = [
	'👨‍👩‍👧‍👦',
	'🇨🇳🇺🇳',
	'مرحبا بالعالم',
	'e\u0301\u0328\u0331',
	'𠮷𩸽',
	'\u200b\u200d\ufe0f',
	'🏳️‍🌈',
	'ᬅᬓ᭄ᬱᬭ',
]

function trickyLine(random) {
	const gen = createGenerator(random)
	return `${TRICKY_TEXT[Math.floor(random() * TRICKY_TEXT.length)]} ${gen.pick(CONTEXT_LINES)} ${'x'.repeat(120)}`
}

/** A multi-hundred-kilobyte command output: one enormous markdown code block. */
function giantLog(kb, random) {
	const gen = createGenerator(random)
	const lines = []
	let size = 0
	const limit = kb * 1024
	let index = 0
	while (size < limit) {
		index += 1
		const line = `${String(index).padStart(6, '0')} ${gen.pick(['INFO', 'WARN', 'TRACE'])} ${trickyLine(random)}`
		lines.push(line)
		size += line.length + 1
	}
	return lines.join('\n')
}

/** A giant pasted prompt: the worst case for message layout and wrapping. */
function giantPrompt(kb, random) {
	const gen = createGenerator(random)
	const lines = [
		'🧪 粘帖的原始日志 / pasted raw log（请摘要，勿逐行执行）：',
		'',
	]
	let size = 0
	while (size < kb * 1024) {
		const line = gen.pick([
			trickyLine(random),
			`| ${String(gen.pickInt(1, 999)).padStart(3, '0')} | ${gen.pick(CONTEXT_LINES)} | 完成 |`,
			`- 步骤 ${gen.pickInt(1, 99)}：${gen.pick(CONTEXT_LINES)}`,
			'x'.repeat(4000),
		])
		lines.push(line)
		size += line.length + 1
	}
	return lines.join('\n')
}

/**
 * A dispatched child agent with its own timeline, reversible patches and
 * timings, so the agent tree, task dispatch and result-notification paths are
 * covered as well.
 */
function buildSubagent({ id, type, status, createdAt, random, vaultPath }) {
	const gen = createGenerator(random)
	const tickAt = (() => {
		let clock = createdAt
		return (ms) => {
			clock += ms
			return clock
		}
	})()
	const timeline = []
	const operations = {}
	const toolTimings = {}
	timeline.push({
		id: messageId(tickAt(5)),
		role: 'user',
		metadata: { createdAt: createdAt },
		parts: [
			{
				type: 'text',
				text: `🧭 ${gen.pick(TOPICS).zh}：阅读样例文档后仅做最小改动。`,
			},
		],
	})
	const rounds = status === 'completed' ? gen.pickInt(2, 4) : 1
	for (let round = 0; round < rounds; round += 1) {
		const parts = [
			{
				type: 'reasoning',
				text: `${gen.pick(REASONING_ZH)} ${gen.pick(REASONING_EN)}`,
				state: 'done',
			},
		]
		const ops = []
		const patchCount = gen.pickInt(1, 3)
		for (let p = 0; p < patchCount; p += 1) {
			const target = `${vaultPath} (${round + 1}.${p + 1})`
			const callId = toolCallId(random)
			const startedAt = tickAt(gen.pickInt(100, 1200))
			const before = noteContent({
				index: round * 10 + p,
				folder: ['📚 样例文档', 'sample-docs'],
				stem: gen.pick(NOTE_STEMS),
				random,
			})
			parts.push({
				type: 'dynamic-tool',
				toolName: 'apply_patch',
				toolCallId: callId,
				input: {
					purpose: `子代理补丁 / subagent patch ${round + 1}.${p + 1}`,
					patch: buildPatch({ path: target, random }),
				},
				state: 'output-available',
				output: { applied: true, files: [target] },
			})
			toolTimings[callId] = {
				startedAt,
				finishedAt: tickAt(gen.pickInt(30, 900)),
			}
			ops.push({
				vaultPath: target,
				operation: 'update',
				before: compressedFile(before),
				after: compressedFile(`${before}${trickyLine(random)}\n`),
				toolCallId: callId,
			})
		}
		const id2 = messageId(tickAt(50))
		timeline.push({
			id: id2,
			role: 'assistant',
			metadata: {
				createdAt: tickAt(1),
				llm: {
					providerId: FIXTURE_PROVIDER.providerId,
					providerName: FIXTURE_PROVIDER.providerName,
					modelId: FIXTURE_MODEL.modelId,
					modelName: FIXTURE_MODEL.modelName,
					usage: usage(random, 4000 + round * 900),
					finishReason: 'tool-calls',
					responseId: `gen-${createdAt}-${gen.slug(10)}`,
				},
			},
			parts,
		})
		operations[id2] = ops
	}
	timeline.push({
		id: messageId(tickAt(30)),
		role: 'assistant',
		metadata: { createdAt: tickAt(1) },
		parts: [
			{
				type: 'text',
				text:
					status === 'completed'
						? '子任务完成：样例文档已按最小改动对齐，差异见可回滚记录。'
						: '子任务被取消：前置条件未满足，未做任何写入。',
			},
		],
	})
	const child = {
		id,
		type,
		status,
		createdAt,
		startedAt: createdAt,
		finishedAt: status === 'completed' ? tickAt(0) : undefined,
		timeline,
		pendingInputs: [],
		operations,
		toolTimings,
		readVaultPaths: [vaultPath],
		subagents: {},
	}
	if (status === 'completed') {
		child.resultPath = `/.agents/nutstore-sync/tmp/${id}.md`
		child.executionId = id
		child.executions = [
			{
				id,
				initiator: 'master',
				createdAt,
				finishedAt: child.finishedAt,
				status: 'completed',
				resultPath: child.resultPath,
			},
		]
	}
	return child
}

function usage(random, promptTokens) {
	const inputTokens = promptTokens
	const outputTokens = 40 + Math.floor(random() * 900)
	return {
		inputTokens,
		inputTokenDetails: {
			noCacheTokens: 3,
			cacheReadTokens: Math.max(0, inputTokens - 64),
			cacheWriteTokens: 64,
		},
		outputTokens,
		outputTokenDetails: { textTokens: outputTokens, reasoningTokens: 0 },
		totalTokens: inputTokens + outputTokens,
		raw: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			total_tokens: inputTokens + outputTokens,
			cost: Number((inputTokens * 1.1e-8 + outputTokens * 1.2e-7).toFixed(9)),
			is_byok: false,
		},
	}
}

function workspaceContext(random, { date, weekday }) {
	return {
		type: 'data-workspace-context',
		data: {
			deltas: [
				{
					key: 'currentDate',
					content: { date, weekday, timezone: 'Asia/Shanghai' },
					hash: createGenerator(random).slug(10),
				},
				{
					key: 'activeFile',
					content: { path: '/📚 样例文档/术语表 0001.md' },
					hash: createGenerator(random).slug(10),
				},
				{
					key: 'openFiles',
					content: [
						{ path: '/📚 样例文档/术语表 0001.md' },
						{ path: '/🧪 压力实验室/实验记录 0002.md' },
					],
					hash: createGenerator(random).slug(10),
				},
				{
					key: 'skills',
					content: [
						{
							name: 'sample-skill',
							description: 'Abstract fixture skill used by stress fixtures.',
							path: '/.agents/skills/sample-skill/SKILL.md',
						},
					],
					hash: createGenerator(random).slug(10),
				},
			],
		},
	}
}

function buildSession({ args, random }) {
	const gen = createGenerator(random)
	const now = Date.now()
	const createdAt = now - args.turns * 60_000
	let clock = createdAt
	const tick = (ms = 1) => {
		clock += ms
		return clock
	}

	const timeline = []
	const operations = {}
	const toolTimings = {}
	const readVaultPaths = []
	const megaStats = []
	const children = {}
	let megaRemaining = args.mega
	let oversizedRemaining = args.oversized
	let giantBashRemaining = args.giantBash
	let giantPromptRemaining = args.giantPrompt
	let subagentsRemaining = args.subagents
	const megaEvery = Math.max(1, Math.floor(args.turns / (args.mega + 1)))
	const oversizedEvery = Math.max(
		1,
		Math.floor(args.turns / (args.oversized + 1)),
	)
	const giantBashEvery = Math.max(
		1,
		Math.floor(args.turns / (args.giantBash + 1)),
	)
	const giantPromptEvery = Math.max(
		1,
		Math.floor(args.turns / (args.giantPrompt + 1)),
	)
	const subagentEvery = Math.max(
		1,
		Math.floor(args.turns / Math.max(1, args.subagents + 1)),
	)

	for (let turn = 0; turn < args.turns; turn += 1) {
		const topic = gen.pick(TOPICS)
		const folder = gen.pick(FOLDER_STEMS)
		const stem = gen.pick(NOTE_STEMS)
		const fileIndex = turn % 24
		const vaultPath = `/${folder[0]}/${stem[0]} ${String(fileIndex).padStart(4, '0')}.md`
		if (!readVaultPaths.includes(vaultPath)) readVaultPaths.push(vaultPath)

		// ----- user turn -----
		const userParts = []
		if (turn % 3 !== 0) {
			const date = new Date(tick(1000)).toISOString().slice(0, 10)
			const weekday = new Date(clock).toLocaleDateString('en-US', {
				weekday: 'long',
			})
			userParts.push(workspaceContext(random, { date, weekday }))
		}
		userParts.push({
			type: 'text',
			text:
				turn % 2 === 0
					? `${topic.emoji} 请${topic.zh}，第 ${turn + 1} 轮。保持中英混排与 emoji 对齐。`
					: `${topic.emoji} Please ${topic.en} (round ${turn + 1}); keep the zh/en/emoji lines aligned.`,
		})
		if (giantPromptRemaining > 0 && turn % giantPromptEvery === 0) {
			giantPromptRemaining -= 1
			userParts.push({
				type: 'text',
				text: giantPrompt(args.giantBashKb, random),
			})
		}
		timeline.push({
			id: messageId(tick(1000)),
			role: 'user',
			metadata: { createdAt: clock },
			parts: userParts,
		})

		// ----- assistant step 1: reasoning + bash + patches -----
		const stepParts = [
			{
				type: 'reasoning',
				text: `${gen.pick(REASONING_ZH)} ${gen.pick(REASONING_EN)}`,
				state: 'done',
			},
		]

		const bash = gen.pick(BASH_SCRIPTS)
		const bashCallId = toolCallId(random)
		const bashStart = tick(400)
		stepParts.push({
			type: 'dynamic-tool',
			toolName: 'bash',
			toolCallId: bashCallId,
			input: {
				purpose: bash.purpose,
				script: bash.script,
				cwd: '/',
				stdin: '',
				rawScript: false,
			},
			state: 'output-available',
			output: [
				`$ ${bash.script}`,
				'--- source: /🧪 压力实验室 ---',
				...Array.from(
					{ length: 6 + gen.pickInt(0, 10) },
					(_, i) =>
						`${String(i + 1).padStart(3, '0')}  ${gen.pick(NOTE_STEMS)[0]} ${String(gen.pickInt(1, 240)).padStart(4, '0')}.md  — ${gen.pick(CONTEXT_LINES)}`,
				),
				`共 ${gen.pickInt(12, 240)} 项；中英混排审计通过 ✅`,
			].join('\n'),
		})
		if (giantBashRemaining > 0 && turn % giantBashEvery === 0) {
			giantBashRemaining -= 1
			// Replace the ordinary listing with a multi-megabyte command log.
			stepParts[stepParts.length - 1].output = giantLog(
				args.giantBashKb,
				random,
			)
		}
		toolTimings[bashCallId] = {
			startedAt: bashStart,
			finishedAt: tick(gen.pickInt(80, 900)),
		}

		const patchCount = gen.pickInt(args.patchMin, args.patchMax)
		const fileOps = []
		const patchedFiles = []
		for (let p = 0; p < patchCount; p += 1) {
			const patchPath =
				p === 0
					? vaultPath
					: `/${folder[0]}/${gen.pick(NOTE_STEMS)[0]} ${String((fileIndex + p) % 96).padStart(4, '0')}.md`
			const before = noteContent({ index: fileIndex + p, folder, stem, random })
			const after = `${before}${INSERT_LINES[Math.floor(random() * INSERT_LINES.length)].slice(1)}\n`
			const callId = toolCallId(random)
			const startedAt = tick(gen.pickInt(120, 2400))
			const patch = buildPatch({ path: patchPath, random })
			stepParts.push({
				type: 'dynamic-tool',
				toolName: 'apply_patch',
				toolCallId: callId,
				input: {
					purpose: `${topic.emoji} ${topic.zh} / ${topic.en} (${p + 1}/${patchCount})`,
					patch,
				},
				state: 'output-available',
				output: { applied: true, files: [patchPath] },
			})
			toolTimings[callId] = {
				startedAt,
				finishedAt: tick(gen.pickInt(40, 1800)),
			}
			fileOps.push({
				vaultPath: patchPath,
				operation: turn === 0 && p === 0 ? 'create' : 'update',
				before:
					turn === 0 && p === 0 ? { kind: 'file' } : compressedFile(before),
				after: compressedFile(after),
				toolCallId: callId,
			})
			if (!patchedFiles.includes(patchPath)) patchedFiles.push(patchPath)
		}

		// ----- mega / oversized patches: a few enormous edits -----
		const megaTurn =
			megaRemaining > 0 && turn % megaEvery === 0
				? { kind: 'mega', chars: args.megaChars }
				: oversizedRemaining > 0 && turn % oversizedEvery === 0
					? {
							kind: 'oversized',
							// Whole-document rewrite far past the 200k diff budget.
							chars: DIFF_TEXT_BUDGET * 4,
						}
					: undefined
		if (megaTurn) {
			const { kind, chars } = megaTurn
			if (kind === 'mega') megaRemaining -= 1
			else oversizedRemaining -= 1
			const sections = megaSections(sectionsForChars(chars, random), random)
			const { after: mutated, changed } = mutateSections(
				sections,
				kind === 'mega' ? 2 : 1,
			)
			const before = renderSections(sections)
			const after = renderSections(mutated)
			const patchPath = `/${folder[0]}/${kind === 'mega' ? '大文件' : '超大文件'}-${String(turn + 1).padStart(4, '0')}.md`
			const callId = toolCallId(random)
			const startedAt = tick(gen.pickInt(800, 6000))
			const patch = buildMegaPatch({
				path: patchPath,
				sections,
				mutated,
				changed,
				maxLines: kind === 'mega' ? 6000 : 12000,
			})
			stepParts.push({
				type: 'dynamic-tool',
				toolName: 'apply_patch',
				toolCallId: callId,
				input: {
					purpose: `${topic.emoji} 重写整篇样例文档 / rewrite the whole sample document (${Math.round(before.length / 1024)} KB, ${changed.size} 节)`,
					patch,
				},
				state: 'output-available',
				output: { applied: true, files: [patchPath] },
			})
			toolTimings[callId] = {
				startedAt,
				finishedAt: tick(gen.pickInt(2000, 12000)),
			}
			// Mega edits rewrite an existing document, so both snapshots exist and the
			// summed diff budget — not just one side — is what gets exercised.
			fileOps.push({
				vaultPath: patchPath,
				operation: kind === 'mega' ? 'update' : 'create',
				before: kind === 'mega' ? compressedFile(before) : { kind: 'file' },
				after: compressedFile(after),
				toolCallId: callId,
			})
			patchedFiles.push(patchPath)
			megaStats.push({
				kind,
				seconds: Number(((clock - startedAt) / 1000).toFixed(2)),
				beforeChars: before.length,
				afterChars: after.length,
				diffUnderBudget: before.length + after.length <= DIFF_TEXT_BUDGET,
				patchChars: patch.length,
				changedSections: changed.size,
			})
		}

		// ----- dispatched child agent: task tool call + child timeline -----
		let dispatched
		if (subagentsRemaining > 0 && turn % subagentEvery === 0) {
			subagentsRemaining -= 1
			const type = gen.pick(['explorer', 'memory'])
			const status = gen.pick([
				'completed',
				'completed',
				'completed',
				'cancelled',
			])
			const childId = `${type}_${gen.slug(6)}-${gen.slug(5)}-${gen.slug(5)}`
			const createdAt = tick(gen.pickInt(50, 600))
			dispatched = buildSubagent({
				id: childId,
				type,
				status,
				createdAt,
				random,
				vaultPath,
			})
			children[childId] = dispatched
			const callId = toolCallId(random)
			const startedAt = tick(gen.pickInt(100, 900))
			stepParts.push({
				type: 'dynamic-tool',
				toolName: 'task',
				toolCallId: callId,
				input: {
					subagent_type: type,
					prompt: `🧭 ${topic.zh} / ${topic.en}：仅处理 ${vaultPath}，完成后汇报。`,
				},
				state: 'output-available',
				output: { taskId: childId, subagentType: type, status: 'dispatched' },
			})
			toolTimings[callId] = {
				startedAt,
				finishedAt: tick(gen.pickInt(50, 700)),
			}
		}

		const assistantStepId = messageId(tick(2000))
		timeline.push({
			id: assistantStepId,
			role: 'assistant',
			metadata: {
				createdAt: clock,
				llm: {
					providerId: FIXTURE_PROVIDER.providerId,
					providerName: FIXTURE_PROVIDER.providerName,
					modelId: FIXTURE_MODEL.modelId,
					modelName: FIXTURE_MODEL.modelName,
					usage: usage(random, 8000 + turn * 340),
					finishReason: 'tool-calls',
					responseId: `gen-${clock}-${gen.slug(12)}`,
				},
			},
			parts: stepParts,
		})
		operations[assistantStepId] = fileOps

		// ----- assistant step 2: closing summary (+ occasional todo list) -----
		const summaryParts = [
			{
				type: 'text',
				text: gen.pick(SUMMARIES).replace('{n}', String(patchCount)),
			},
		]
		if (turn % 7 === 0) {
			summaryParts.push({
				type: 'data-todos',
				data: {
					items: [
						{
							content: `${topic.emoji} ${topic.zh}`,
							status: 'completed',
							priority: 'high',
						},
						{
							content: `复核 ${patchedFiles.length} 个文件的差异 (diff review)`,
							status: 'in_progress',
							priority: 'medium',
						},
						{
							content: 'Re-run the consistency check on zh/en/emoji lines',
							status: 'pending',
							priority: 'low',
						},
					],
				},
			})
		}
		if (dispatched?.resultPath) {
			summaryParts.push({
				type: 'data-system-notification',
				data: {
					kind: 'task-result-ready',
					taskId: dispatched.id,
					resultPath: dispatched.resultPath,
					runId: dispatched.executionId,
					sender: dispatched.id,
					recipient: 'master',
					createdAt: dispatched.finishedAt ?? clock,
				},
			})
		}
		timeline.push({
			id: messageId(tick(2000)),
			role: 'assistant',
			metadata: {
				createdAt: clock,
				llm: {
					providerId: FIXTURE_PROVIDER.providerId,
					providerName: FIXTURE_PROVIDER.providerName,
					modelId: FIXTURE_MODEL.modelId,
					modelName: FIXTURE_MODEL.modelName,
					usage: usage(random, 8000 + turn * 340 + patchCount * 120),
					finishReason: 'stop',
					responseId: `gen-${clock}-${gen.slug(12)}`,
				},
			},
			parts: summaryParts,
		})
	}

	const session = {
		schemaVersion: 2,
		id: args.id,
		createdAt,
		updatedAt: clock,
		model: {
			providerId: FIXTURE_PROVIDER.providerId,
			modelId: FIXTURE_MODEL.modelId,
		},
		recentMemories: [
			{
				id: gen.slug(10),
				fromMsgId: timeline[0].id,
				toMsgId: timeline[timeline.length - 1].id,
				sourceHash: gen.slug(10),
				memory:
					'Stress fixture: a long chat with many reversible patches; all content is abstract sample data.',
				ctime: clock,
				mtime: clock,
			},
		],
		subagents: {
			master: {
				id: 'master',
				type: 'master',
				status: 'idle',
				createdAt,
				timeline,
				pendingInputs: [],
				operations,
				toolTimings,
				readVaultPaths,
				subagents: children,
			},
		},
	}
	return {
		session,
		title: args.title,
		megaStats,
		children: Object.keys(children).length,
	}
}

function updateMeta({ vault, id, title, createdAt, updatedAt }) {
	const metaPath = join(vault, META_PATH)
	if (!existsSync(metaPath))
		return { updated: false, reason: 'chat-meta.json not found' }
	let meta
	try {
		meta = JSON.parse(readFileSync(metaPath, 'utf8'))
	} catch {
		return { updated: false, reason: 'chat-meta.json is not valid JSON' }
	}
	meta.orderedSessionIds = [
		id,
		...(meta.orderedSessionIds ?? []).filter((item) => item !== id),
	]
	meta.sessions = meta.sessions ?? {}
	meta.sessions[id] = { title, createdAt, updatedAt }
	writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
	return { updated: true, metaPath }
}

const args = parseArgs(process.argv.slice(2))
const random = createRandom(args.seed)
const { session, title, megaStats, children } = buildSession({ args, random })

const sessionsDir = join(args.vault, SESSIONS_DIR)
const outPath = join(sessionsDir, `${session.id}.json`)
writeFileSync(outPath, `${JSON.stringify({ session, title }, null, 2)}\n`)

const meta = args.meta
	? updateMeta({
			vault: args.vault,
			id: session.id,
			title,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
		})
	: { updated: false, reason: 'disabled by --no-meta' }

const master = session.subagents.master
const parts = master.timeline.flatMap((message) => message.parts)
const patchCalls = parts.filter(
	(part) => part.toolName === 'apply_patch',
).length
const childAgents = Object.values(master.subagents)
const biggestToolOutput = Math.max(
	0,
	...parts.map((part) =>
		typeof part.output === 'string' ? part.output.length : 0,
	),
)
const biggestUserText = Math.max(
	0,
	...master.timeline
		.filter((message) => message.role === 'user')
		.flatMap((message) => message.parts)
		.map((part) => (part.type === 'text' ? part.text.length : 0)),
)
console.log(
	JSON.stringify(
		{
			outPath,
			fileMb: Number((statSync(outPath).size / 1024 / 1024).toFixed(1)),
			turns: args.turns,
			messages: master.timeline.length,
			patchCalls,
			operations: Object.values(master.operations).reduce(
				(sum, ops) => sum + ops.length,
				0,
			),
			toolTimings: Object.keys(master.toolTimings).length,
			childAgents: children,
			childMessages: childAgents.reduce(
				(sum, child) => sum + child.timeline.length,
				0,
			),
			childPatches: childAgents
				.flatMap((child) => child.timeline)
				.flatMap((message) => message.parts)
				.filter((part) => part.toolName === 'apply_patch').length,
			biggestToolOutputKb: Math.round(biggestToolOutput / 1024),
			biggestUserTextKb: Math.round(biggestUserText / 1024),
			megaPatches: megaStats,
			megaCharsClamped: args.megaCharsClamped,
			megaDiffBudget: DIFF_TEXT_BUDGET,
			meta,
		},
		null,
		2,
	),
)
