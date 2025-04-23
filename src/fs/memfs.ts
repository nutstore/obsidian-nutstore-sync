import { cloneDeep } from 'lodash-es'
import { basename, normalize } from 'path'
import { StatModel } from '~/model/stat.model'
import IFileSystem from './fs.interface'

interface TreeNode {
	stat: StatModel
	children: Map<string, TreeNode>
}

export default class memfs extends IFileSystem {
	private root: TreeNode = {
		stat: {
			path: '/',
			basename: '',
			isDir: true,
			isDeleted: false,
			mtime: Date.now(),
			size: 0,
		},
		children: new Map<string, TreeNode>(),
	}

	constructor(stats: StatModel[]) {
		super()
		for (const stat of stats) {
			if (stat.isDeleted) {
				continue
			}
			this.addNodeToTree({ ...stat, path: this.normalizePath(stat.path) })
		}
	}

	private addNodeToTree(stat: StatModel): void {
		const pathParts = stat.path.split('/').filter(Boolean)
		let currentNode = this.root
		let currentPath = ''

		// Create parent directories along the path if they don't exist
		for (let i = 0; i < pathParts.length - 1; i++) {
			const part = pathParts[i]
			currentPath = currentPath === '' ? `/${part}` : `${currentPath}/${part}`

			if (!currentNode.children.has(part)) {
				currentNode.children.set(part, {
					stat: {
						path: currentPath,
						basename: part,
						isDir: true,
						isDeleted: false,
						mtime: Date.now(),
						size: 0,
					},
					children: new Map<string, TreeNode>(),
				})
			} else {
				// Check if the existing node is a directory
				const node = currentNode.children.get(part)!
				if (!node.stat.isDir) {
					// If it's a file, we can't add children to it - just return
					return
				}
			}

			currentNode = currentNode.children.get(part)!
		}

		// Add the actual file/directory at the end of the path
		if (pathParts.length > 0) {
			const name = pathParts[pathParts.length - 1]
			currentNode.children.set(name, {
				stat: { ...stat, basename: name },
				children: new Map<string, TreeNode>(),
			})
		}
	}

	/**
	 * Find a node by path
	 */
	private findNode(path: string): TreeNode | null {
		if (path === '/') return this.root

		const pathParts = path.split('/').filter(Boolean)
		let currentNode = this.root

		for (const part of pathParts) {
			if (!currentNode.children.has(part)) {
				return null
			}
			currentNode = currentNode.children.get(part)!
		}

		return currentNode
	}

	/**
	 * Get the parent path of a given path
	 */
	private getParentPath(path: string): string {
		if (path === '/') return '/'

		const parts = path.split('/').filter(Boolean)

		if (parts.length === 1) {
			return '/'
		}

		parts.pop()
		return '/' + parts.join('/')
	}

	/**
	 * Check if any node's path starts with the given prefix
	 */
	private hasChildrenWithPrefix(path: string): boolean {
		const pathPrefix = path === '/' ? '/' : `${path}/`

		// Helper for recursively checking nodes
		const checkNode = (node: TreeNode): boolean => {
			// Check direct children first
			for (const [childName, childNode] of node.children) {
				const childPath =
					node === this.root
						? `/${childName}`
						: `${node.stat.path}/${childName}`

				if (childPath.startsWith(pathPrefix)) {
					return true
				}

				// Check their children recursively
				if (childNode.stat.isDir && checkNode(childNode)) {
					return true
				}
			}

			return false
		}

		return checkNode(this.root)
	}

	/**
	 * Return all stats in the filesystem
	 */
	walk(): StatModel[] {
		const stats: StatModel[] = []

		// Helper function for traversing the tree
		const walkTree = (node: TreeNode) => {
			// Skip the root node in the results
			if (node !== this.root) {
				stats.push(cloneDeep(node.stat))
			}

			// Traverse all children
			for (const child of node.children.values()) {
				walkTree(child)
			}
		}

		walkTree(this.root)
		return stats
	}

	/**
	 * Check if a file or directory exists
	 */
	exists(path: string): boolean {
		path = this.normalizePath(path)

		// Root always exists
		if (path === '/') {
			return true
		}

		// Check for exact path match
		const node = this.findNode(path)
		if (node) {
			return true
		}

		// Check if it's an implicit directory (has children with this path as prefix)
		const pathPrefix = path === '/' ? '/' : `${path}/`
		return this.hasChildrenWithPrefix(path)
	}

	/**
	 * Get information about a file or directory
	 */
	stat(path: string): StatModel | null {
		path = this.normalizePath(path)

		// Special case for root
		if (path === '/') {
			return cloneDeep(this.root.stat)
		}

		// Check for exact path match
		const node = this.findNode(path)
		if (node) {
			return cloneDeep(node.stat)
		}

		// Check if it's an implicit directory
		const pathPrefix = path === '/' ? '/' : `${path}/`
		if (this.hasChildrenWithPrefix(path)) {
			return {
				path,
				basename: path === '/' ? '' : basename(path),
				isDir: true,
				isDeleted: false,
				mtime: Date.now(),
				size: 0,
			}
		}

		return null
	}

	/**
	 * List the contents of a directory
	 *
	 * @param path The directory path to list
	 * @returns Array of StatModel for the direct children of the path
	 * @throws Error if the path doesn't exist or isn't a directory
	 */
	list(path: string): StatModel[] {
		path = this.normalizePath(path)

		// Make sure the path exists and is a directory
		const pathStat = this.stat(path)
		if (!pathStat) {
			throw new Error(`Path does not exist: ${path}`)
		}

		if (!pathStat.isDir) {
			throw new Error(`Path is not a directory: ${path}`)
		}

		// Get all direct children
		const children = new Map<string, StatModel>()
		const pathPrefix = path === '/' ? '/' : `${path}/`

		// If it's a real node, add its direct children
		const node = this.findNode(path)
		if (node) {
			for (const [childName, childNode] of node.children) {
				children.set(childName, cloneDeep(childNode.stat))
			}
		}

		// Find implicit directories by traversing the tree
		// and looking for paths that start with the prefix
		const collectVirtualDirs = (
			currentNode: TreeNode,
			currentPath: string = '',
		) => {
			for (const [childName, childNode] of currentNode.children) {
				const childPath =
					currentNode === this.root
						? `/${childName}`
						: `${currentPath}/${childName}`

				// Skip if not under the requested path
				if (!childPath.startsWith(pathPrefix)) continue

				// Get the relative path and extract just the first segment
				const relativePath = childPath.slice(pathPrefix.length)
				const firstSegment = relativePath.split('/')[0]

				if (!firstSegment) continue // Skip the path itself

				const virtualPath = `${pathPrefix}${firstSegment}`

				// If this is a direct child, we already have it
				// If not, add a virtual directory entry
				if (relativePath.includes('/') && !children.has(firstSegment)) {
					children.set(firstSegment, {
						path: virtualPath,
						basename: firstSegment,
						isDir: true,
						isDeleted: false,
						mtime: Date.now(),
						size: 0,
					})
				}

				// Continue traversing if it's a directory
				if (childNode.stat.isDir) {
					collectVirtualDirs(childNode, childPath)
				}
			}
		}

		collectVirtualDirs(this.root)

		return Array.from(children.values())
	}

	/**
	 * Normalize a path to ensure consistent handling
	 */
	private normalizePath(path: string): string {
		if (!path.startsWith('/')) {
			path = `/${path}`
		}

		path = normalize(path)

		if (path.length > 1 && path.endsWith('/')) {
			path = path.slice(0, -1)
		}

		return path
	}

	/**
	 * Delete a file or directory
	 *
	 * @param path The path to delete
	 * @param recursive Whether to recursively delete directories (default: false)
	 * @returns True if deleted successfully, false if path doesn't exist
	 * @throws Error if trying to delete a non-empty directory without recursive flag or attempting to delete root
	 */
	delete(path: string, recursive: boolean = false): boolean {
		path = this.normalizePath(path)

		// Special handling for root
		if (path === '/') {
			if (recursive) {
				// Clear everything
				this.root.children.clear()
				return true
			} else {
				throw new Error('Cannot delete root directory without recursive flag')
			}
		}

		// Check if path exists
		if (!this.exists(path)) {
			return false
		}

		// Find the parent path and the basename
		const parentPath = this.getParentPath(path)
		const basename = path.split('/').filter(Boolean).pop()!

		// Find the parent node
		const parentNode = this.findNode(parentPath)

		// Handle exact node deletion
		if (parentNode && parentNode.children.has(basename)) {
			const nodeToDelete = parentNode.children.get(basename)!

			// For directories, check if it contains items
			if (
				nodeToDelete.stat.isDir &&
				nodeToDelete.children.size > 0 &&
				!recursive
			) {
				throw new Error(`Cannot delete non-empty directory: ${path}`)
			}

			// Delete the node
			parentNode.children.delete(basename)
			return true
		}

		// Handle implicit directory deletion
		const stat = this.stat(path)
		if (stat?.isDir) {
			// If it's an implicit directory, the findNode would have returned null
			// so we need to manually check and delete children
			if (recursive) {
				// Delete all children with this prefix
				this.deleteChildrenWithPrefix(path)
				return true
			} else {
				// Check if it contains any children
				const children = this.list(path)
				if (children.length > 0) {
					throw new Error(`Cannot delete non-empty directory: ${path}`)
				}

				// If we reach here, it was an empty implicit directory
				return true
			}
		}

		return false
	}

	/**
	 * Delete all nodes whose path starts with the given prefix
	 */
	private deleteChildrenWithPrefix(prefix: string): void {
		const pathPrefix = prefix === '/' ? '/' : `${prefix}/`

		const deleteRecursively = (node: TreeNode, nodePath: string) => {
			// Get all child names first to avoid modification during iteration
			const childNames = Array.from(node.children.keys())

			for (const childName of childNames) {
				const childNode = node.children.get(childName)!
				const childPath =
					nodePath === '/' ? `/${childName}` : `${nodePath}/${childName}`

				if (childPath === prefix || childPath.startsWith(pathPrefix)) {
					// This node should be deleted
					node.children.delete(childName)
				} else if (childNode.stat.isDir) {
					// Check children of this directory
					deleteRecursively(childNode, childPath)
				}
			}
		}

		deleteRecursively(this.root, '/')
	}

	/**
	 * Update timestamp of an existing file, or create a new file.
	 * Throws an error if the path exists and is a directory.
	 * Creates parent directories if they don't exist.
	 */
	touch(path: string): boolean
	touch(stat: StatModel): boolean
	touch(pathOrStat: string | StatModel): boolean {
		// Handle string path
		if (typeof pathOrStat === 'string') {
			// Normalize the path
			const path = this.normalizePath(pathOrStat)

			// Check if path already exists
			const existingStat = this.stat(path)
			if (existingStat) {
				// If it's a directory, throw error
				if (existingStat.isDir) {
					throw new Error(`Path exists and is a directory: ${path}`)
				}
				// If it's a file, update the timestamp
				existingStat.mtime = Date.now()
				// If it's a node with an entry in the tree, update it there
				const node = this.findNode(path)
				if (node) {
					node.stat.mtime = existingStat.mtime
				}
				return true
			}

			// Create new file
			const basename =
				path === '/' ? '' : path.split('/').filter(Boolean).pop()!

			// Create a new StatModel
			const newStat: StatModel = {
				path,
				basename,
				isDir: false, // Always create as file
				isDeleted: false,
				mtime: Date.now(),
				size: 0,
			}

			// Ensure parent directory exists (create it if needed using mkdir)
			const parentPath = this.getParentPath(path)
			if (!this.exists(parentPath)) {
				this.mkdir(parentPath) // Use mkdir
			} else {
				const parentStat = this.stat(parentPath)
				if (!parentStat!.isDir) {
					throw new Error(`Parent path is not a directory: ${parentPath}`)
				}
			}

			// Add the node to the tree
			this.addNodeToTree(newStat)
			return true
		} else {
			// Handle StatModel object
			const stat = { ...pathOrStat, path: this.normalizePath(pathOrStat.path) }

			// Check if path already exists
			const existingStat = this.stat(stat.path)
			if (existingStat) {
				// If it's a directory, throw error
				if (existingStat.isDir) {
					throw new Error(`Path exists and is a directory: ${stat.path}`)
				}
				// If it's a file, update the timestamp
				existingStat.mtime = Date.now()
				// If it's a node with an entry in the tree, update it there
				const node = this.findNode(stat.path)
				if (node) {
					node.stat.mtime = existingStat.mtime
				}
				return true
			}

			// Ensure parent directory exists (create it if needed using mkdir)
			const parentPath = this.getParentPath(stat.path)
			if (!this.exists(parentPath)) {
				this.mkdir(parentPath) // Use mkdir
			} else {
				const parentStat = this.stat(parentPath)
				if (!parentStat!.isDir) {
					throw new Error(`Parent path is not a directory: ${parentPath}`)
				}
			}

			// Add the node to the tree (ensure isDir is false)
			this.addNodeToTree({ ...stat, isDir: false })
			return true
		}
	}

	/**
	 * Create a directory and its parent directories if they don't exist.
	 * Behaves like `mkdir -p`.
	 * @param path The directory path to create
	 * @returns True if directory was created or already exists as a directory
	 * @throws Error if path exists but is not a directory
	 */
	mkdir(path: string): boolean {
		// Normalize the path
		path = this.normalizePath(path)

		// Check if path already exists
		const existingStat = this.stat(path)
		if (existingStat) {
			// If it exists but is not a directory, throw an error
			if (!existingStat.isDir) {
				throw new Error(`Path exists but is not a directory: ${path}`)
			}
			// If it exists as a directory, update the timestamp and return true
			existingStat.mtime = Date.now()
			const node = this.findNode(path)
			if (node) {
				node.stat.mtime = existingStat.mtime
			}
			return true
		}

		// Create parent directories if they don't exist
		const parentPath = this.getParentPath(path)
		if (parentPath !== path && !this.exists(parentPath)) {
			this.mkdir(parentPath) // Recursive call to mkdir
		} else if (parentPath !== path) {
			// Ensure parent exists and is a directory
			const parentStat = this.stat(parentPath)
			if (!parentStat || !parentStat.isDir) {
				throw new Error(
					`Cannot create directory. Parent path is not a directory: ${parentPath}`,
				)
			}
		}

		// Create the directory
		const basename = path === '/' ? '' : path.split('/').filter(Boolean).pop()!

		// Create a new StatModel
		const newStat: StatModel = {
			path,
			basename,
			isDir: true,
			isDeleted: false,
			mtime: Date.now(),
			size: 0,
		}

		// Add the node to the tree
		this.addNodeToTree(newStat)
		return true
	}
}
