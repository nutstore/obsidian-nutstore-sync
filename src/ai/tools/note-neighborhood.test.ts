import { describe, expect, it } from 'vitest'
import { buildNoteNeighborhood } from './note-neighborhood'

describe('buildNoteNeighborhood', () => {
	it('collects undirected neighbors within the requested depth', () => {
		const graph = buildNoteNeighborhood(
			{
				'a.md': {
					'b.md': 1,
				},
				'b.md': {
					'c.md': 1,
				},
				'd.md': {
					'a.md': 1,
				},
			},
			'a.md',
			1,
		)

		expect(graph).toEqual({
			root: 'a.md',
			depth: 1,
			adj: {
				'a.md': ['b.md', 'd.md'],
				'b.md': ['a.md'],
				'd.md': ['a.md'],
			},
		})
	})

	it('includes edges between visited nodes at deeper levels', () => {
		const graph = buildNoteNeighborhood(
			{
				'a.md': {
					'b.md': 1,
					'c.md': 1,
				},
				'b.md': {
					'd.md': 1,
				},
				'c.md': {
					'd.md': 1,
				},
			},
			'a.md',
			2,
		)

		expect(graph.adj).toEqual({
			'a.md': ['b.md', 'c.md'],
			'b.md': ['a.md', 'd.md'],
			'c.md': ['a.md', 'd.md'],
			'd.md': ['b.md', 'c.md'],
		})
	})

	it('returns the root with an empty adjacency list when isolated', () => {
		expect(buildNoteNeighborhood({}, 'solo.md', 3)).toEqual({
			root: 'solo.md',
			depth: 3,
			adj: {
				'solo.md': [],
			},
		})
	})

	it('normalizes negative depth to zero', () => {
		expect(
			buildNoteNeighborhood(
				{
					'a.md': {
						'b.md': 1,
					},
				},
				'a.md',
				-1,
			),
		).toEqual({
			root: 'a.md',
			depth: 0,
			adj: {
				'a.md': [],
			},
		})
	})
})
