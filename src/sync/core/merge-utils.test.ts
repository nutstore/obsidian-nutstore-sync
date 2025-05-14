import { Buffer } from 'buffer' // Import Buffer for explicit Buffer testing
import { describe, expect, it } from 'vitest'
import {
	LatestTimestampResolution,
	resolveByIntelligentMerge,
	resolveByLatestTimestamp,
	type IntelligentMergeParams,
	type LatestTimestampParams,
} from './merge-utils'

describe('resolveByLatestTimestamp', () => {
	// --- 无更改 ---
	it('情况 1.1: 时间戳相同，应无更改', () => {
		const params: LatestTimestampParams = {
			localMtime: 1000,
			remoteMtime: 1000,
			localContent: Buffer.from('abc'),
			remoteContent: Buffer.from('abc'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.NoChange)
	})

	it('情况 1.2: 远程较新但内容相同，应无更改', () => {
		const params: LatestTimestampParams = {
			localMtime: 1000,
			remoteMtime: 1001,
			localContent: Buffer.from('abc'),
			remoteContent: Buffer.from('abc'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.NoChange)
	})

	it('情况 1.3: 本地较新但内容相同，应无更改', () => {
		const params: LatestTimestampParams = {
			localMtime: 1001,
			remoteMtime: 1000,
			localContent: Buffer.from('abc'),
			remoteContent: Buffer.from('abc'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.NoChange)
	})

	// --- 使用远程版本 ---
	it('情况 2.1: 远程较新且内容不同，应使用远程版本', () => {
		const params: LatestTimestampParams = {
			localMtime: 1000,
			remoteMtime: 1001,
			localContent: Buffer.from('abc'),
			remoteContent: Buffer.from('abcd'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.UseRemote)
		if (result.status === LatestTimestampResolution.UseRemote) {
			expect(result.content).toEqual(Buffer.from('abcd'))
		}
	})

	it('情况 2.2: 远程较新，Buffer 内容不同，应使用远程版本', () => {
		const params: LatestTimestampParams = {
			localMtime: 1000,
			remoteMtime: 1001,
			localContent: Buffer.from('binarydata1'),
			remoteContent: Buffer.from('binarydata2'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.UseRemote)
		if (result.status === LatestTimestampResolution.UseRemote) {
			expect(result.content).toEqual(Buffer.from('binarydata2'))
		}
	})

	// --- 使用本地版本 ---
	it('情况 3.1: 本地较新且内容不同，应使用本地版本', () => {
		const params: LatestTimestampParams = {
			localMtime: 1001,
			remoteMtime: 1000,
			localContent: Buffer.from('xyz'),
			remoteContent: Buffer.from('xy'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.UseLocal)
		if (result.status === LatestTimestampResolution.UseLocal) {
			expect(result.content).toEqual(Buffer.from('xyz'))
		}
	})

	it('情况 3.2: 本地较新，Buffer 内容不同，应使用本地版本', () => {
		const params: LatestTimestampParams = {
			localMtime: 1001,
			remoteMtime: 1000,
			localContent: Buffer.from('localbinary'),
			remoteContent: Buffer.from('remotebinary'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.UseLocal)
		if (result.status === LatestTimestampResolution.UseLocal) {
			expect(result.content).toEqual(Buffer.from('localbinary'))
		}
	})
})

describe('resolveByIntelligentMerge', () => {
	// --- 内容一致 ---
	it('情况 1.1: 本地与远程内容一致，应成功且标记为相同', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'line1\nline2',
			localContentText: 'line1\nline2\nline3',
			remoteContentText: 'line1\nline2\nline3',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.isIdentical).toBe(true)
	})

	// --- node-diff3 成功合并 ---
	it('情况 2.1: 本地新增，远程不变 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'a\nb',
			localContentText: 'a\nb\nc',
			remoteContentText: 'a\nb',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('a\nb\nc')
	})

	it('情况 2.2: 远程删除，本地不变 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'a\nb\nc',
			localContentText: 'a\nb\nc',
			remoteContentText: 'a\nc',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('a\nc')
	})

	it('情况 2.3: 本地修改，远程不变 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'hello world',
			localContentText: 'hello universe',
			remoteContentText: 'hello world',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('hello universe')
	})

	it('情况 2.4: 并发无重叠修改 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'line1\nline2\nline3\nline4',
			localContentText: 'line1-local\nline2\nline3\nline4',
			remoteContentText: 'line1\nline2\nline3\nline4-remote',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('line1-local\nline2\nline3\nline4-remote')
	})

	it('情况 2.5: 本地在开头修改 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'original line',
			localContentText: 'new first line\noriginal line',
			remoteContentText: 'original line',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('new first line\noriginal line')
	})

	it('情况 2.6: 远程在末尾修改 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'original line',
			localContentText: 'original line',
			remoteContentText: 'original line\nnew last line',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('original line\nnew last line')
	})

	// --- dmp 回退合并测试 ---
	it('情况 3.1: node-diff3 冲突，dmp 回退亦无法解决', async () => {
		// 此场景模拟 diff3 在 'shared_line' 上报告冲突
		const params: IntelligentMergeParams = {
			baseContentText: 'common_prefix\nshared_line_base\ncommon_suffix',
			localContentText:
				'common_prefix\nshared_line_local_version\ncommon_suffix', // Local made a change
			remoteContentText:
				'common_prefix\nshared_line_remote_version\ncommon_suffix', // Remote also made a change
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false)
	})

	it('情况 3.2: node-diff3 冲突，但 dmp 回退成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: '第一行\n共同祖先\n第三行',
			localContentText: '第一行\n本地修改了共同祖先\n第三行\n本地新增行', // 本地修改并添加
			remoteContentText: '第一行\n共同祖先被修改了\n第三行', // 远程仅修改
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			'第一行\n本地修改了共同祖先被修改了\n第三行\n本地新增行',
		)
	})

	it('情况 3.3: 并发编辑句子 - 一个添加修饰词，另一个更改名词 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'The cat sat on the mat.',
			localContentText: 'The fluffy cat sat on the mat.', // User A adds "fluffy"
			remoteContentText: 'The cat sat on the rug.', // User B changes "mat" to "rug"
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('The fluffy cat sat on the rug.')
	})

	it('情况 3.4: 同一行文本两端同时编辑 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'This is a shared line of text.',
			localContentText: 'NEW_PREFIX This is a shared line of text.', // User A adds a prefix
			remoteContentText: 'This is a shared line of text. NEW_SUFFIX', // User B adds a suffix
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			'NEW_PREFIX This is a shared line of text. NEW_SUFFIX',
		)
	})

	it('情况 3.5: 复杂交织的真实冲突 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'Report for Q1: Sales are up by 10%.',
			localContentText:
				'Urgent Report for Q1: Sales are significantly up by 10%.',
			remoteContentText: 'Report for Q1: Revenue is up by 10%, not sales.',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			'Urgent Report for Q1: Revenue is significantly up by 10%, not sales.',
		)
	})

	it('情况 3.6: 大段文本 - 两端非冲突编辑 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `This is the first sentence of a long paragraph that serves as a base for testing.
It contains multiple lines and ideas to simulate a real-world text block.
The middle section of this paragraph will remain untouched by direct edits from either local or remote.
However, changes will occur at the beginning and at the very end of this paragraph.
This setup helps verify if DMP can handle non-overlapping changes in a larger text body.`,
			localContentText: `A new introductory sentence has been added locally.
This is the first sentence of a long paragraph that serves as a base for testing.
It contains multiple lines and ideas to simulate a real-world text block.
The middle section of this paragraph will remain untouched by direct edits from either local or remote.
However, changes will occur at the beginning and at the very end of this paragraph.
This setup helps verify if DMP can handle non-overlapping changes in a larger text body.`,
			remoteContentText: `This is the first sentence of a long paragraph that serves as a base for testing.
It contains multiple lines and ideas to simulate a real-world text block.
The middle section of this paragraph will remain untouched by direct edits from either local or remote.
However, changes will occur at the beginning and at the very end of this paragraph.
This setup helps verify if DMP can handle non-overlapping changes in a larger text body.
And a concluding sentence has been added remotely.`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`A new introductory sentence has been added locally.
This is the first sentence of a long paragraph that serves as a base for testing.
It contains multiple lines and ideas to simulate a real-world text block.
The middle section of this paragraph will remain untouched by direct edits from either local or remote.
However, changes will occur at the beginning and at the very end of this paragraph.
This setup helps verify if DMP can handle non-overlapping changes in a larger text body.
And a concluding sentence has been added remotely.`,
		)
	})

	it('情况 3.7: 多段文本 - 不同段落非冲突编辑 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `Paragraph one, initial state.
It has a few lines.

Paragraph two, also in its initial state.
This one also has some content.`,
			localContentText: `Paragraph one, with local modifications.
It has a few lines, and this is a local addition.

Paragraph two, also in its initial state.
This one also has some content.`,
			remoteContentText: `Paragraph one, initial state.
It has a few lines.

Paragraph two, with remote changes applied.
This one also has some content, and this is a remote addition.`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`Paragraph one, with local modifications.
It has a few lines, and this is a local addition.

Paragraph two, with remote changes applied.
This one also has some content, and this is a remote addition.`,
		)
	})

	it('情况 3.8: 大段文本 - 内部冲突编辑 (DMP 失败)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `The project's primary goal is to enhance user experience.
We will achieve this by redesigning the interface and optimizing performance.
The timeline for this phase is three months.`,
			localContentText: `The project's primary goal is to revolutionize user interaction.
We will achieve this by completely overhauling the UI and boosting speed.
The timeline for this critical phase is two months.`,
			remoteContentText: `The project's main objective is to improve customer satisfaction.
We will achieve this by simplifying the navigation and ensuring stability.
The deadline for this phase is strictly four months.`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false)
	})

	it('情况 3.9: 多段文本 - 一段冲突，其他段落非冲突 (DMP 失败)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `Paragraph A: Initial content for the first section.
It discusses introductory concepts.

Paragraph B: Core ideas are presented here.
This section is crucial for understanding.

Paragraph C: Concluding remarks and future work.
This summarizes the document.`,
			localContentText: `Paragraph A: Initial content for the first section, with local additions.
It discusses introductory concepts and some new insights.

Paragraph B: Core ideas are presented here, but locally rephrased for clarity.
This section is absolutely vital for comprehension.

Paragraph C: Concluding remarks and future work.
This summarizes the document.`,
			remoteContentText: `Paragraph A: Initial content for the first section.
It discusses introductory concepts, expanded with remote details.

Paragraph B: Core concepts are detailed in this part.
This section is fundamentally important for understanding.

Paragraph C: Concluding remarks and future work, with an added action item.
This summarizes the document and suggests next steps.`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false) // Conflict in Paragraph B should cause overall failure
	})

	it('情况 3.10: 大段中文文本 - 两端非冲突编辑 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `这是一段用于测试的长中文段落的第一句话。
它包含多行内容和若干观点，旨在模拟真实的文本块。
该段落的中间部分将保持不变，本地和远程均不直接编辑。
然而，段落的开头和末尾会发生更改。
此设置有助于验证DMP是否能处理较长文本主体中的非重叠更改。`,
			localContentText: `本地新增了一个引言句。
这是一段用于测试的长中文段落的第一句话。
它包含多行内容和若干观点，旨在模拟真实的文本块。
该段落的中间部分将保持不变，本地和远程均不直接编辑。
然而，段落的开头和末尾会发生更改。
此设置有助于验证DMP是否能处理较长文本主体中的非重叠更改。`,
			remoteContentText: `这是一段用于测试的长中文段落的第一句话。
它包含多行内容和若干观点，旨在模拟真实的文本块。
该段落的中间部分将保持不变，本地和远程均不直接编辑。
然而，段落的开头和末尾会发生更改。
此设置有助于验证DMP是否能处理较长文本主体中的非重叠更改。
并且远程添加了一个总结句。`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`本地新增了一个引言句。
这是一段用于测试的长中文段落的第一句话。
它包含多行内容和若干观点，旨在模拟真实的文本块。
该段落的中间部分将保持不变，本地和远程均不直接编辑。
然而，段落的开头和末尾会发生更改。
此设置有助于验证DMP是否能处理较长文本主体中的非重叠更改。
并且远程添加了一个总结句。`,
		)
	})

	it('情况 3.11: 多段中文文本 - 不同段落非冲突编辑 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `段落一，初始状态。
它有几行文字。

段落二，同样处于初始状态。
这一个也有一些内容。`,
			localContentText: `段落一，经过本地修改。
它有几行文字，这是本地新增的内容。

段落二，同样处于初始状态。
这一个也有一些内容。`,
			remoteContentText: `段落一，初始状态。
它有几行文字。

段落二，已应用远程更改。
这一个也有一些内容，这是远程新增的内容。`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`段落一，经过本地修改。
它有几行文字，这是本地新增的内容。

段落二，已应用远程更改。
这一个也有一些内容，这是远程新增的内容。`,
		)
	})

	it('情况 3.12: 大段中文文本 - 内部冲突编辑 (DMP 失败)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `项目的主要目标是提升用户体验。
我们将通过重新设计界面和优化性能来实现这一目标。
此阶段的时间表为三个月。`,
			localContentText: `项目的主要目标是革新用户交互。
我们将通过彻底改造用户界面并提升速度来实现。
这个关键阶段的时间表为两个月。`,
			remoteContentText: `项目的主要目的是提高客户满意度。
我们将通过简化导航和确保稳定性来实现。
此阶段的截止日期严格限定为四个月。`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false)
	})

	it('情况 3.13: 多段中文文本 - 一段冲突，其他段落非冲突 (DMP 失败)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `段落甲：第一部分的初始内容。
它讨论了介绍性的概念。

段落乙：核心思想在此呈现。
这部分对于理解至关重要。

段落丙：结论和未来工作。
这总结了文档。`,
			localContentText: `段落甲：第一部分的初始内容，附带本地增补。
它讨论了介绍性的概念和一些新的见解。

段落乙：核心思想在此呈现，但本地为了清晰重新表述。
这部分对于理解绝对关键。

段落丙：结论和未来工作。
这总结了文档。`,
			remoteContentText: `段落甲：第一部分的初始内容。
它讨论了介绍性的概念，并用远程细节进行了扩展。

段落乙：核心概念在这一部分有详细说明。
这部分对于理解具有根本的重要性。

段落丙：结论和未来工作，并增加了一个行动项。
这总结了文档并建议了后续步骤。`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false) // Conflict in 段落乙 should cause overall failure
	})

	// --- Markdown Specific Test Cases ---
	it('情况 3.14: Markdown - 非冲突编辑 (本地添加列表，远程修改段落) (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `# Section Title

This is the original paragraph content. It discusses important concepts.`,
			localContentText: `# Section Title

This is the original paragraph content. It discusses important concepts.

- Item 1
- Item 2`,
			remoteContentText: `# Section Title

This is the modified paragraph content by remote. It elaborates on the important concepts with new details.`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`# Section Title

This is the modified paragraph content by remote. It elaborates on the important concepts with new details.

- Item 1
- Item 2`,
		)
	})

	it('情况 3.15: Markdown - 列表内非冲突编辑 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `- First item: original text.
- Second item: original text.
- Third item: original text.`,
			localContentText: `- First item: locally modified text.
- Second item: original text.
- Third item: original text.`,
			remoteContentText: `- First item: original text.
- Second item: remotely modified text.
- Third item: original text.`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`- First item: locally modified text.
- Second item: remotely modified text.
- Third item: original text.`,
		)
	})

	it('情况 3.16: Markdown - 标题冲突 (DMP 失败)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `## Original Subheading`,
			localContentText: `## Locally Updated Subheading`,
			remoteContentText: `## Remotely Revised Subheading`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false)
	})

	it('情况 3.17: Markdown - 大型知识库片段 - 复杂非冲突编辑 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `# Main Topic: System Architecture

## Introduction
This document outlines the system architecture. Key components include the API, database, and frontend.

## Components
- **API Server:** Handles all client requests.
  - Built with Node.js.
- **Database:** Stores persistent data.
  - Uses PostgreSQL.
- **Frontend:** User interface.
  - Developed with React.

### Data Flow
Data flows from Frontend -> API Server -> Database.`,
			localContentText: `# Main Topic: System Architecture

## Introduction
This document outlines the system architecture. Key components include the API, database, and frontend.

## Components
- **API Server:** Handles all client requests and business logic.
  - Built with Node.js and Express.
- **Database:** Stores persistent data.
  - Uses PostgreSQL.
- **Frontend:** User interface.
  - Developed with React.
- **Caching Layer:** (New) Improves performance.
  - Uses Redis.

### Data Flow
Data flows from Frontend -> API Server -> Database.`,
			remoteContentText: `# Main Topic: System Architecture

## Introduction
This document provides a comprehensive overview of the system architecture. Key components include the API, database, and frontend, working in concert.

## Components
- **API Server:** Handles all client requests.
  - Built with Node.js.
- **Database:** Stores persistent data.
  - Uses PostgreSQL.
- **Frontend:** User interface for interaction.
  - Developed with React and Redux for state management.

### Data Flow
Data flows from Frontend -> API Server -> Database.`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`# Main Topic: System Architecture

## Introduction
This document provides a comprehensive overview of the system architecture. Key components include the API, database, and frontend, working in concert.

## Components
- **API Server:** Handles all client requests and business logic.
  - Built with Node.js and Express.
- **Database:** Stores persistent data.
  - Uses PostgreSQL.
- **Frontend:** User interface for interaction.
  - Developed with React and Redux for state management.
- **Caching Layer:** (New) Improves performance.
  - Uses Redis.

### Data Flow
Data flows from Frontend -> API Server -> Database.`,
		)
	})

	it('情况 3.18: Markdown - 大型知识库片段 - 复杂冲突编辑 (DMP 失败)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `# Project Alpha: Guidelines

## Setup Instructions
1. Clone the repository.
2. Run \`npm install\`.
3. Run \`npm start\`.

## Coding Standards
- Use Prettier for formatting.
- Write unit tests for all new features.`,
			localContentText: `# Project Alpha: Guidelines

## Setup Instructions
1. Clone the repository from the new URL.
2. Run \`yarn install\`.
3. Run \`yarn dev\`.

## Coding Standards
- Use Prettier for formatting.
- Write unit tests for all new features.
- All functions must have JSDoc comments.`,
			remoteContentText: `# Project Alpha: Guidelines

## Setup Instructions
1. Ensure you have Docker installed.
2. Run \`docker-compose up\`.

## Coding Standards
- Use ESLint and Prettier for formatting and linting.
- Write unit tests for all new features.`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false)
	})

	it('情况 3.19: Markdown (中文) - 非冲突编辑 (本地添加列表，远程修改段落) (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `# 章节标题

这是原始的段落内容。它讨论了重要的概念。`,
			localContentText: `# 章节标题

这是原始的段落内容。它讨论了重要的概念。

- 项目点 1
- 项目点 2`,
			remoteContentText: `# 章节标题

这是由远程修改的段落内容。它用新的细节阐述了重要的概念。`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`# 章节标题

这是由远程修改的段落内容。它用新的细节阐述了重要的概念。

- 项目点 1
- 项目点 2`,
		)
	})

	it('情况 3.20: Markdown (中文) - 大型知识库片段 - 复杂非冲突编辑 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `# 主题：系统架构

## 引言
本文档概述了系统架构。关键组件包括API、数据库和前端。

## 组件详情
- **API服务器：** 处理所有客户端请求。
  - 使用Node.js构建。
- **数据库：** 存储持久化数据。
  - 使用PostgreSQL。
- **前端：** 用户界面。
  - 使用React开发。`,
			localContentText: `# 主题：系统架构

## 引言
本文档概述了系统架构。关键组件包括API、数据库和前端。

## 组件详情
- **API服务器：** 处理所有客户端请求及业务逻辑。
  - 使用Node.js和Express构建。
- **数据库：** 存储持久化数据。
  - 使用PostgreSQL。
- **前端：** 用户界面。
  - 使用React开发。
- **缓存层：** (新增) 提升性能。
  - 使用Redis。`,
			remoteContentText: `# 主题：系统架构

## 引言
本文档对系统架构进行了全面概述。关键组件包括API、数据库和前端，它们协同工作。

## 组件详情
- **API服务器：** 处理所有客户端请求。
  - 使用Node.js构建。
- **数据库：** 存储持久化数据。
  - 使用PostgreSQL。
- **前端：** 用于交互的用户界面。
  - 使用React和Redux进行状态管理。`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`# 主题：系统架构

## 引言
本文档对系统架构进行了全面概述。关键组件包括API、数据库和前端，它们协同工作。

## 组件详情
- **API服务器：** 处理所有客户端请求及业务逻辑。
  - 使用Node.js和Express构建。
- **数据库：** 存储持久化数据。
  - 使用PostgreSQL。
- **前端：** 用于交互的用户界面。
  - 使用React和Redux进行状态管理。
- **缓存层：** (新增) 提升性能。
  - 使用Redis。`,
		)
	})

	it('情况 3.21: Markdown (中文) - 大型知识库片段 - 复杂冲突编辑 (DMP 失败)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `# 项目甲：开发指南

## 环境设置
1. 克隆代码仓库。
2. 运行 \`npm install\`。
3. 运行 \`npm start\`。

##编码规范
- 使用 Prettier 进行格式化。
- 为所有新功能编写单元测试。`,
			localContentText: `# 项目甲：开发指南

## 环境设置
1. 从新的URL克隆代码仓库。
2. 运行 \`yarn install\`。
3. 运行 \`yarn dev\`。

##编码规范
- 使用 Prettier 进行格式化。
- 为所有新功能编写单元测试。
- 所有函数必须有 JSDoc 注释。`,
			remoteContentText: `# 项目甲：开发指南

## 环境设置
1. 确保已安装 Docker。
2. 运行 \`docker-compose up\`。

##编码规范
- 使用 ESLint 和 Prettier 进行格式化和代码检查。
- 为所有新功能编写单元测试。`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false)
	})

	it('情况 3.22: Markdown - 本地在文档中间插入大段文字，远程在末尾小幅修改 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `# 原始标题

这是文档的初始段落。
它包含了一些基本信息。

这是文档的结束部分。`,
			localContentText: `# 原始标题

这是文档的初始段落。
它包含了一些基本信息。

## 本地新增章节

这是本地插入的一大段新内容。
它可能包含多个段落，详细阐述某个主题。
例如，这里可以有列表：
- 列表项A
- 列表项B

甚至可以有更复杂的 Markdown 结构。

这是文档的结束部分。`,
			remoteContentText: `# 原始标题

这是文档的初始段落。
它包含了一些基本信息。

这是文档的结束部分。远程在这里添加了一句总结性的话。`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`# 原始标题

这是文档的初始段落。
它包含了一些基本信息。

## 本地新增章节

这是本地插入的一大段新内容。
它可能包含多个段落，详细阐述某个主题。
例如，这里可以有列表：
- 列表项A
- 列表项B

甚至可以有更复杂的 Markdown 结构。

这是文档的结束部分。远程在这里添加了一句总结性的话。`,
		)
	})

	it('情况 3.23: Markdown - 本地和远程在不同位置分别插入大段非冲突文字 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `# 文档标题

## 章节一：引言

这是引言内容。

## 章节二：核心概念

这是核心概念的阐述。

## 章节三：结论

这是结论部分。`,
			localContentText: `# 文档标题

## 章节一：引言

这是引言内容。

### 本地新增：引言的补充说明

这部分是本地在引言章节中新增的详细内容。
它可以很长，包含多个要点。
- 要点1
- 要点2

## 章节二：核心概念

这是核心概念的阐述。

## 章节三：结论

这是结论部分。`,
			remoteContentText: `# 文档标题

## 章节一：引言

这是引言内容。

## 章节二：核心概念

这是核心概念的阐述。

### 远程新增：核心概念的案例分析

这部分是远程在核心概念章节中新增的案例。
它可以包含代码示例：
\`\`\`
function example() {
  console.log("Hello from remote");
}
\`\`\`
以及对案例的详细解释。

## 章节三：结论

这是结论部分。`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`# 文档标题

## 章节一：引言

这是引言内容。

### 本地新增：引言的补充说明

这部分是本地在引言章节中新增的详细内容。
它可以很长，包含多个要点。
- 要点1
- 要点2

## 章节二：核心概念

这是核心概念的阐述。

### 远程新增：核心概念的案例分析

这部分是远程在核心概念章节中新增的案例。
它可以包含代码示例：
\`\`\`
function example() {
  console.log("Hello from remote");
}
\`\`\`
以及对案例的详细解释。

## 章节三：结论

这是结论部分。`,
		)
	})

	it('情况 3.24: Markdown - 本地插入一个极长的段落，远程在另一处添加简短注释 (DMP 成功)', async () => {
		const longParagraph = `这是一个极长的段落，模拟用户在Obsidian中撰写或粘贴大量文本的场景。这个段落需要足够长，以测试合并算法在处理大块文本时的性能和准确性。它可以包含各种类型的文本，例如详细的解释、复杂的思考过程、或者从其他地方引用的长篇内容。为了达到“极长”的目的，我会在这里重复一些句子，或者添加一些无意义的填充文本。这仅仅是为了增加段落的字符数和行数。在实际应用中，这样的段落通常会包含有价值的信息，但对于测试来说，长度是关键。我们希望确保即使用户进行了如此大规模的单次编辑，合并过程依然能够正确处理，并且不会丢失任何信息，也不会引入错误。这个段落将继续延伸，以确保它确实很长。重复的文本有助于快速增加长度，同时保持一定的可读性（尽管内容上可能没有新增信息）。这个段落现在应该已经足够长了，可以有效地测试我们想要验证的场景。再加几句确保长度。这真的是一个很长的段落，对吧？我们还在继续写，确保它足够长。最后几句了，这个段落的长度应该可以满足测试需求了。`
		const params: IntelligentMergeParams = {
			baseContentText: `# 原始文档

第一段内容。

第二段内容，这里将保持不变。

最后一段。`,
			localContentText: `# 原始文档

第一段内容。

${longParagraph}

第二段内容，这里将保持不变。

最后一段。`,
			remoteContentText: `# 原始文档 (远程修改了标题)

第一段内容。

第二段内容，这里将保持不变。

最后一段。 (远程添加了注释)`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`# 原始文档 (远程修改了标题)

第一段内容。

${longParagraph}

第二段内容，这里将保持不变。

最后一段。 (远程添加了注释)`,
		)
	})

	it('情况 3.25: Markdown - 本地插入大段文字，远程删除另一不相关段落 (DMP 成功)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `# 初始文档结构

## 第一节：引言

这是引言部分的文字。

## 第二节：待删除内容

这部分内容将在远程版本中被删除。
它包含几行文字，用于测试删除操作。

## 第三节：核心论述

这是核心论述部分。`,
			localContentText: `# 初始文档结构

## 第一节：引言

这是引言部分的文字。

### 本地新增：引言的扩展

这里是本地在引言部分新增的大段内容。
它详细地扩展了引言中的观点。
可以包含多个小节和列表。
- 扩展点1
- 扩展点2

## 第二节：待删除内容

这部分内容将在远程版本中被删除。
它包含几行文字，用于测试删除操作。

## 第三节：核心论述

这是核心论述部分。`,
			remoteContentText: `# 初始文档结构

## 第一节：引言

这是引言部分的文字。

## 第三节：核心论述

这是核心论述部分。 (远程在此处可能有一些微小调整)`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe(
			`# 初始文档结构

## 第一节：引言

这是引言部分的文字。

### 本地新增：引言的扩展

这里是本地在引言部分新增的大段内容。
它详细地扩展了引言中的观点。
可以包含多个小节和列表。
- 扩展点1
- 扩展点2

## 第三节：核心论述

这是核心论述部分。 (远程在此处可能有一些微小调整)`,
		)
	})

	it('情况 3.26: Markdown - 本地和远程在同一位置附近插入大段冲突文字 (DMP 失败)', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: `# 会议纪要

## 议题一：项目进展

主持人总结了上周的工作。

## 议题二：后续计划`,
			localContentText: `# 会议纪要

## 议题一：项目进展

主持人总结了上周的工作。

### 本地补充：关于A模块的详细讨论

张三详细介绍了A模块的技术实现细节，遇到的问题以及解决方案。
李四补充了A模块与B模块的集成方案。
王五提出了关于A模块性能优化的建议。
（此处省略数百字详细讨论记录）

## 议题二：后续计划`,
			remoteContentText: `# 会议纪要

## 议题一：项目进展

主持人总结了上周的工作。

### 远程补充：关于用户反馈的整理

赵六整理了上周收集到的用户反馈，主要集中在C功能和D功能的体验问题。
钱七分析了反馈产生的原因，并提出了初步的改进方向。
（此处省略数百字用户反馈详情及分析）

## 议题二：后续计划`,
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false)
	})

	// --- 合并失败 ---
	it('情况 4.1: 真冲突，两种算法均无法解决', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'line1\nconflicting_line_base\nline3',
			localContentText: 'line1\nconflicting_line_local_change_A\nline3',
			remoteContentText: 'line1\nconflicting_line_remote_change_B\nline3',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false)
	})

	// --- 内容边缘情况 ---
	it('情况 5.1: 基础内容为空，本地与远程冲突', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: '',
			localContentText: 'local only content',
			remoteContentText: 'remote only content',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false)
	})

	it('情况 5.1b: 基础内容为空，本地与远程内容相同', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: '',
			localContentText: 'same content',
			remoteContentText: 'same content',
		}
		// local and remote are identical, so it's not a merge conflict, it's just identical.
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.isIdentical).toBe(true)
	})

	it('情况 5.2: 本地内容为空，基础和远程均有内容', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'some base content\nshared line',
			localContentText: '', // Local deleted everything
			remoteContentText: 'some base content\nshared line\nremote additions', // Remote kept base and added
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(false)
	})

	it('情况 5.3: 所有内容均为空', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: '',
			localContentText: '',
			remoteContentText: '',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.isIdentical).toBe(true)
	})
})
