export interface TreeNode {
	name: string
	path: string
	type: 'folder' | 'file'
	children?: TreeNode[]
}

export function flattenTreeNodes(nodes: TreeNode[], depth: number) {
	if (depth < 1) {
		return []
	}

	const items: Array<{
		name: string
		path: string
		type: 'folder' | 'file'
	}> = []

	for (const node of nodes) {
		items.push({
			name: node.name,
			path: node.path,
			type: node.type,
		})

		if (node.type === 'folder' && depth > 1 && node.children?.length) {
			items.push(...flattenTreeNodes(node.children, depth - 1))
		}
	}

	return items
}
