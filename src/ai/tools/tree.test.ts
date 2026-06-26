import { describe, expect, it } from 'vitest'
import { flattenTreeNodes, type TreeNode } from './tree'

const sampleTree: TreeNode[] = [
	{
		name: 'Projects',
		path: 'Projects',
		type: 'folder',
		children: [
			{
				name: 'Alpha.md',
				path: 'Projects/Alpha.md',
				type: 'file',
			},
			{
				name: 'Nested',
				path: 'Projects/Nested',
				type: 'folder',
				children: [
					{
						name: 'Deep.md',
						path: 'Projects/Nested/Deep.md',
						type: 'file',
					},
				],
			},
		],
	},
	{
		name: 'Inbox.md',
		path: 'Inbox.md',
		type: 'file',
	},
]

describe('flattenTreeNodes', () => {
	it('returns only direct children at depth 1', () => {
		expect(flattenTreeNodes(sampleTree, 1).map((item) => item.path)).toEqual([
			'Projects',
			'Inbox.md',
		])
	})

	it('returns descendants up to the requested depth', () => {
		expect(flattenTreeNodes(sampleTree, 2).map((item) => item.path)).toEqual([
			'Projects',
			'Projects/Alpha.md',
			'Projects/Nested',
			'Inbox.md',
		])
		expect(flattenTreeNodes(sampleTree, 3).map((item) => item.path)).toEqual([
			'Projects',
			'Projects/Alpha.md',
			'Projects/Nested',
			'Projects/Nested/Deep.md',
			'Inbox.md',
		])
	})

	it('returns no items for depth below 1', () => {
		expect(flattenTreeNodes(sampleTree, 0)).toEqual([])
	})
})
