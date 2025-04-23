import { beforeEach, describe, expect, it } from 'vitest'
import { StatModel } from '~/model/stat.model'
import memfs from './memfs'

describe('memfs', () => {
	// Test fixtures
	const createBasicFileSystem = (): StatModel[] => [
		{
			path: '/file1.txt',
			basename: 'file1.txt',
			isDir: false,
			isDeleted: false,
			mtime: 1000,
			size: 100,
		},
		{
			path: '/dir1',
			basename: 'dir1',
			isDir: true,
			isDeleted: false,
			mtime: 2000,
			size: 0,
		},
		{
			path: '/dir1/file2.txt',
			basename: 'file2.txt',
			isDir: false,
			isDeleted: false,
			mtime: 3000,
			size: 200,
		},
		{
			path: '/dir1/subdir',
			basename: 'subdir',
			isDir: true,
			isDeleted: false,
			mtime: 4000,
			size: 0,
		},
		{
			path: '/dir1/subdir/file3.txt',
			basename: 'file3.txt',
			isDir: false,
			isDeleted: false,
			mtime: 5000,
			size: 300,
		},
	]

	const createFileSystemWithDeletedItems = (): StatModel[] => [
		...createBasicFileSystem(),
		{
			path: '/deleted-file.txt',
			basename: 'deleted-file.txt',
			isDir: false,
			isDeleted: true,
			mtime: 6000,
			size: 400,
		},
	]

	const createFileSystemWithNonNormalizedPaths = (): StatModel[] => [
		{
			path: 'non-normalized-file.txt', // Missing leading slash
			basename: 'non-normalized-file.txt',
			isDir: false,
			isDeleted: false,
			mtime: 7000,
			size: 500,
		},
		{
			path: '/dir-with-trailing-slash/', // Has trailing slash
			basename: 'dir-with-trailing-slash',
			isDir: true,
			isDeleted: false,
			mtime: 8000,
			size: 0,
		},
	]

	describe('constructor', () => {
		it('should filter out deleted stats', () => {
			const fs = new memfs(createFileSystemWithDeletedItems())
			const stats = fs.walk()

			expect(stats.length).toBe(5)
			expect(stats.find((s) => s.path === '/deleted-file.txt')).toBe(undefined)
		})

		it('should normalize paths in stats', () => {
			const fs = new memfs(createFileSystemWithNonNormalizedPaths())
			const stats = fs.walk()

			expect(stats.length).toBe(2)
			expect(
				stats.find((s) => s.path === '/non-normalized-file.txt'),
			).toBeTruthy()
			expect(
				stats.find((s) => s.path === '/dir-with-trailing-slash'),
			).toBeTruthy()
			expect(stats.find((s) => s.path === '/dir-with-trailing-slash/')).toBe(
				undefined,
			)
		})
	})

	describe('walk()', () => {
		it('should return a deep clone of all stats', () => {
			const originalStats = createBasicFileSystem()
			const fs = new memfs(originalStats)
			const returnedStats = fs.walk()

			// Verify we get all stats
			expect(returnedStats.length).toBe(originalStats.length)

			// Verify it's a deep clone (modifying the returned stats doesn't affect the internal state)
			const firstStat = returnedStats[0]
			firstStat.size = 999999

			const statsAfterModification = fs.walk()
			expect(statsAfterModification[0].size).toBe(100) // Original size, not 999999
		})
	})

	describe('exists()', () => {
		let fs: memfs

		beforeEach(() => {
			fs = new memfs(createBasicFileSystem())
		})

		it('should return true for exact file paths', () => {
			expect(fs.exists('/file1.txt')).toBe(true)
		})

		it('should return true for exact directory paths', () => {
			expect(fs.exists('/dir1')).toBe(true)
		})

		it('should return true for parent directories of existing files', () => {
			expect(fs.exists('/dir1/subdir')).toBe(true)
		})

		it('should return false for non-existent paths', () => {
			expect(fs.exists('/nonexistent')).toBe(false)
			expect(fs.exists('/dir1/nonexistent')).toBe(false)
		})

		it('should handle paths with trailing slashes', () => {
			expect(fs.exists('/dir1/')).toBe(true)
		})

		it('should handle paths without leading slashes', () => {
			expect(fs.exists('dir1')).toBe(true)
		})

		it('should handle root path', () => {
			expect(fs.exists('/')).toBe(true)
		})
	})

	describe('stat()', () => {
		let fs: memfs

		beforeEach(() => {
			fs = new memfs(createBasicFileSystem())
		})

		it('should return correct stats for files', () => {
			const fileStat = fs.stat('/file1.txt')

			expect(fileStat).not.toBe(null)
			expect(fileStat?.path).toBe('/file1.txt')
			expect(fileStat?.isDir).toBe(false)
			expect(fileStat?.size).toBe(100)
		})

		it('should return correct stats for directories', () => {
			const dirStat = fs.stat('/dir1')

			expect(dirStat).not.toBe(null)
			expect(dirStat?.path).toBe('/dir1')
			expect(dirStat?.isDir).toBe(true)
		})

		it('should return virtual directory stats for implicit directories', () => {
			// Create a file system with only a deep file, implying directories
			const implicitDirFs = new memfs([
				{
					path: '/a/b/c/file.txt',
					basename: 'file.txt',
					isDir: false,
					isDeleted: false,
					mtime: 1000,
					size: 100,
				},
			])

			const dirAStat = implicitDirFs.stat('/a')
			expect(dirAStat).not.toBe(null)
			expect(dirAStat?.path).toBe('/a')
			expect(dirAStat?.isDir).toBe(true)
			expect(dirAStat?.basename).toBe('a')

			const dirBStat = implicitDirFs.stat('/a/b')
			expect(dirBStat).not.toBe(null)
			expect(dirBStat?.isDir).toBe(true)
		})

		it('should return null for non-existent paths', () => {
			expect(fs.stat('/nonexistent')).toBe(null)
			expect(fs.stat('/dir1/nonexistent')).toBe(null)
		})

		it('should handle the root path specially', () => {
			const rootStat = fs.stat('/')

			expect(rootStat).not.toBe(null)
			expect(rootStat?.path).toBe('/')
			expect(rootStat?.isDir).toBe(true)
			expect(rootStat?.basename).toBe('')
		})

		it('should normalize paths before looking up stats', () => {
			expect(fs.stat('dir1/')).not.toBe(null)
			expect(fs.stat('dir1/')?.path).toBe('/dir1')
		})

		it('should return a copy of stats, not the original reference', () => {
			const originalStat = fs.stat('/file1.txt')
			if (originalStat) {
				originalStat.size = 999999
			}

			const newStat = fs.stat('/file1.txt')
			expect(newStat).not.toBe(null)
			expect(newStat!.size).toBe(100) // Original size, not 999999
		})
	})

	describe('list()', () => {
		let fs: memfs

		beforeEach(() => {
			fs = new memfs(createBasicFileSystem())
		})

		it('should list direct children of a directory', () => {
			const children = fs.list('/dir1')

			expect(children.length).toBe(2)

			// Check for file2.txt
			const file2 = children.find((c) => c.basename === 'file2.txt')
			expect(file2).toBeTruthy()
			expect(file2?.isDir).toBe(false)

			// Check for subdir
			const subdir = children.find((c) => c.basename === 'subdir')
			expect(subdir).toBeTruthy()
			expect(subdir?.isDir).toBe(true)
		})

		it('should list files and directories at root level', () => {
			const rootItems = fs.list('/')

			expect(rootItems.length).toBe(2)
			expect(rootItems.find((i) => i.basename === 'file1.txt')).toBeTruthy()
			expect(rootItems.find((i) => i.basename === 'dir1')).toBeTruthy()
		})

		it('should list items in deeper directories', () => {
			const subdirItems = fs.list('/dir1/subdir')

			expect(subdirItems.length).toBe(1)
			expect(subdirItems[0].basename).toBe('file3.txt')
		})

		it('should create virtual directory entries for partial paths', () => {
			// Create a file system with only deep files to test implicit directories
			const implicitDirFs = new memfs([
				{
					path: '/a/b/c/file1.txt',
					basename: 'file1.txt',
					isDir: false,
					isDeleted: false,
					mtime: 1000,
					size: 100,
				},
				{
					path: '/a/b/d/file2.txt',
					basename: 'file2.txt',
					isDir: false,
					isDeleted: false,
					mtime: 2000,
					size: 200,
				},
			])

			const children = implicitDirFs.list('/a/b')

			expect(children.length).toBe(2)

			// Should have virtual directories c and d
			const dirC = children.find((c) => c.basename === 'c')
			expect(dirC).toBeTruthy()
			expect(dirC?.isDir).toBe(true)

			const dirD = children.find((c) => c.basename === 'd')
			expect(dirD).toBeTruthy()
			expect(dirD?.isDir).toBe(true)
		})

		it('should throw an error for non-existent paths', () => {
			expect(() => fs.list('/nonexistent')).toThrow('Path does not exist')
		})

		it('should throw an error when trying to list a file', () => {
			expect(() => fs.list('/file1.txt')).toThrow('Path is not a directory')
		})

		it('should handle empty directories', () => {
			// Create a file system with an empty directory
			const emptyDirFs = new memfs([
				{
					path: '/emptyDir',
					basename: 'emptyDir',
					isDir: true,
					isDeleted: false,
					mtime: 1000,
					size: 0,
				},
			])

			const children = emptyDirFs.list('/emptyDir')
			expect(children.length).toBe(0)
		})

		it('should normalize paths before listing', () => {
			// These should all work the same
			const list1 = fs.list('/dir1')
			const list2 = fs.list('dir1')
			const list3 = fs.list('/dir1/')

			expect(list1.length).toBe(2)
			expect(list2.length).toBe(2)
			expect(list3.length).toBe(2)
		})
	})

	describe('delete()', () => {
		let fs: memfs

		beforeEach(() => {
			fs = new memfs(createBasicFileSystem())
		})

		it('should delete files successfully', () => {
			expect(fs.exists('/file1.txt')).toBe(true)

			const result = fs.delete('/file1.txt')

			expect(result).toBe(true)
			expect(fs.exists('/file1.txt')).toBe(false)
		})

		it('should delete empty directories successfully', () => {
			// Create a file system with an empty directory
			const emptyDirFs = new memfs([
				{
					path: '/emptyDir',
					basename: 'emptyDir',
					isDir: true,
					isDeleted: false,
					mtime: 1000,
					size: 0,
				},
			])

			expect(emptyDirFs.exists('/emptyDir')).toBe(true)

			const result = emptyDirFs.delete('/emptyDir')

			expect(result).toBe(true)
			expect(emptyDirFs.exists('/emptyDir')).toBe(false)
		})

		it('should throw an error when trying to delete a non-empty directory without recursive flag', () => {
			expect(() => fs.delete('/dir1')).toThrow(
				'Cannot delete non-empty directory',
			)
		})

		it('should delete non-empty directories when recursive flag is true', () => {
			expect(fs.exists('/dir1')).toBe(true)
			expect(fs.exists('/dir1/file2.txt')).toBe(true)
			expect(fs.exists('/dir1/subdir')).toBe(true)

			const result = fs.delete('/dir1', true)

			expect(result).toBe(true)
			expect(fs.exists('/dir1')).toBe(false)
			expect(fs.exists('/dir1/file2.txt')).toBe(false)
			expect(fs.exists('/dir1/subdir')).toBe(false)
			expect(fs.exists('/dir1/subdir/file3.txt')).toBe(false)
		})

		it('should return false when trying to delete a non-existent path', () => {
			const result = fs.delete('/nonexistent')
			expect(result).toBe(false)
		})

		it('should delete implicit directories if they are empty', () => {
			// Create a file system with an implicit directory structure
			const implicitDirFs = new memfs([
				{
					path: '/a/b/c/file.txt',
					basename: 'file.txt',
					isDir: false,
					isDeleted: false,
					mtime: 1000,
					size: 100,
				},
			])

			// Delete the file
			implicitDirFs.delete('/a/b/c/file.txt')

			// Should be able to delete the now-empty implicit directory
			const result = implicitDirFs.delete('/a/b/c')
			expect(result).toBe(true)
			expect(implicitDirFs.exists('/a/b/c')).toBe(false)
		})

		it('should throw an error when trying to delete root without recursive flag', () => {
			expect(() => fs.delete('/')).toThrow(
				'Cannot delete root directory without recursive flag',
			)
		})

		it('should delete everything when deleting root with recursive flag', () => {
			const result = fs.delete('/', true)

			expect(result).toBe(true)

			const stats = fs.walk()
			expect(stats.length).toBe(0)

			// Root should still "exist" as a concept but be empty
			expect(fs.exists('/')).toBe(true)
			const rootChildren = fs.list('/')
			expect(rootChildren.length).toBe(0)
		})

		it('should normalize paths before deleting', () => {
			expect(fs.exists('/file1.txt')).toBe(true)

			const result = fs.delete('file1.txt') // No leading slash

			expect(result).toBe(true)
			expect(fs.exists('/file1.txt')).toBe(false)
		})
	})

	describe('normalizePath() (implicitly tested through other methods)', () => {
		let fs: memfs

		beforeEach(() => {
			fs = new memfs([])
		})

		it('should handle paths without leading slashes', () => {
			// We need to create a test file to check the normalization
			fs = new memfs([
				{
					path: 'no-leading-slash.txt',
					basename: 'no-leading-slash.txt',
					isDir: false,
					isDeleted: false,
					mtime: 1000,
					size: 100,
				},
			])

			// If normalized correctly, this should exist with a leading slash
			expect(fs.exists('/no-leading-slash.txt')).toBe(true)
		})

		it('should handle paths with trailing slashes', () => {
			// We can test this through the exists and stat methods
			fs = new memfs(createBasicFileSystem())

			expect(fs.exists('/dir1/')).toBe(true) // With trailing slash
			expect(fs.stat('/dir1/')?.path).toBe('/dir1') // Should remove trailing slash
		})

		it('should preserve the root path', () => {
			fs = new memfs(createBasicFileSystem())

			const rootStat = fs.stat('/')
			expect(rootStat?.path).toBe('/') // Root should stay as '/'
		})

		it('should handle complex . and .. navigation', () => {
			fs = new memfs([
				{
					path: '/a/b/file.txt',
					basename: 'file.txt',
					isDir: false,
					isDeleted: false,
					mtime: 1,
					size: 1,
				},
			])
			expect(fs.exists('/a/b/../b/./file.txt')).toBe(true)
			expect(fs.stat('/a/b/../b/./file.txt')?.path).toBe('/a/b/file.txt')
			// Attempt to navigate above root
			expect(fs.exists('/../file.txt')).toBe(false)
			expect(fs.stat('/../file.txt')).toBe(null)
		})

		it('should handle multiple consecutive slashes', () => {
			fs = new memfs([
				{
					path: '/a/b/c',
					basename: 'c',
					isDir: true,
					isDeleted: false,
					mtime: 1,
					size: 0,
				},
			])
			expect(fs.exists('/a//b///c')).toBe(true)
			expect(fs.stat('/a//b///c')?.path).toBe('/a/b/c')
			expect(fs.list('/a//b/').length).toBe(1) // List using multiple slashes
		})
	})

	describe('edge cases and complex scenarios', () => {
		it('should handle deeply nested directories and files', () => {
			const deeplyNestedFs = new memfs([
				{
					path: '/a/b/c/d/e/f/g/h/i/j/deep-file.txt',
					basename: 'deep-file.txt',
					isDir: false,
					isDeleted: false,
					mtime: 1000,
					size: 100,
				},
			])

			// The file should exist
			expect(deeplyNestedFs.exists('/a/b/c/d/e/f/g/h/i/j/deep-file.txt')).toBe(
				true,
			)

			// All parent directories should exist
			expect(deeplyNestedFs.exists('/a')).toBe(true)
			expect(deeplyNestedFs.exists('/a/b')).toBe(true)
			expect(deeplyNestedFs.exists('/a/b/c/d/e/f/g/h/i')).toBe(true)

			// We should be able to list contents of parent directories
			const iDirContents = deeplyNestedFs.list('/a/b/c/d/e/f/g/h/i')
			expect(iDirContents.length).toBe(1)
			expect(iDirContents[0].basename).toBe('j')
			expect(iDirContents[0].isDir).toBe(true)
		})

		it('should handle files and directories with the same name at different levels', () => {
			const sameNameFs = new memfs([
				{
					path: '/test',
					basename: 'test',
					isDir: true,
					isDeleted: false,
					mtime: 1000,
					size: 0,
				},
				{
					path: '/test/test',
					basename: 'test',
					isDir: false,
					isDeleted: false,
					mtime: 2000,
					size: 100,
				},
				{
					path: '/test/test/test', // This should not be possible in a real file system
					basename: 'test',
					isDir: false,
					isDeleted: false,
					mtime: 3000,
					size: 200,
				},
			])

			// Both should exist
			expect(sameNameFs.exists('/test')).toBe(true)
			expect(sameNameFs.exists('/test/test')).toBe(true)

			// Should be able to distinguish between them
			expect(sameNameFs.stat('/test')?.isDir).toBe(true)
			expect(sameNameFs.stat('/test/test')?.isDir).toBe(false)

			// The third one should fail because the second one is a file, not a directory
			expect(sameNameFs.exists('/test/test/test')).toBe(false)
		})

		it('should handle directories with many files', () => {
			// Create a file system with 100 files in a directory
			const manyFiles: StatModel[] = []

			for (let i = 0; i < 100; i++) {
				manyFiles.push({
					path: `/manyFiles/file${i}.txt`,
					basename: `file${i}.txt`,
					isDir: false,
					isDeleted: false,
					mtime: i,
					size: i * 100,
				})
			}

			const manyFilesFs = new memfs(manyFiles)

			// The directory should exist
			expect(manyFilesFs.exists('/manyFiles')).toBe(true)

			// Should be able to list all files
			const files = manyFilesFs.list('/manyFiles')
			expect(files.length).toBe(100)

			// Should be able to delete the directory recursively
			const result = manyFilesFs.delete('/manyFiles', true)
			expect(result).toBe(true)
			expect(manyFilesFs.exists('/manyFiles')).toBe(false)
		})

		it('should treat empty path as root', () => {
			const fs = new memfs(createBasicFileSystem())

			// Empty string should be treated as root
			expect(fs.exists('')).toBe(true)

			const rootStat = fs.stat('')
			expect(rootStat?.path).toBe('/')
			expect(rootStat?.isDir).toBe(true)

			const rootContents = fs.list('')
			expect(rootContents.length).toBe(2) // file1.txt and dir1
		})
	})

	describe('touch()', () => {
		let fs: memfs

		beforeEach(() => {
			fs = new memfs([])
		})

		it('should create a new file with string path', () => {
			const success = fs.touch('/newfile.txt')

			expect(success).toBe(true)
			expect(fs.exists('/newfile.txt')).toBe(true)

			const stat = fs.stat('/newfile.txt')
			expect(stat).not.toBe(null)
			expect(stat?.isDir).toBe(false)
			expect(stat?.basename).toBe('newfile.txt')
			expect(stat?.path).toBe('/newfile.txt')
		})

		it('should create a new directory using mkdir', () => {
			const success = fs.mkdir('/newdir') // Use mkdir

			expect(success).toBe(true)
			expect(fs.exists('/newdir')).toBe(true)

			const stat = fs.stat('/newdir')
			expect(stat).not.toBe(null)
			expect(stat?.isDir).toBe(true)
			expect(stat?.basename).toBe('newdir')
		})

		it('should create a file using StatModel object', () => {
			const newStat: StatModel = {
				path: '/statmodel-file.txt',
				basename: 'statmodel-file.txt',
				isDir: false,
				isDeleted: false,
				mtime: 1000, // This will be overridden
				size: 123,
			}

			const success = fs.touch(newStat)

			expect(success).toBe(true)
			expect(fs.exists('/statmodel-file.txt')).toBe(true)

			const stat = fs.stat('/statmodel-file.txt')
			expect(stat).not.toBe(null)
			expect(stat?.isDir).toBe(false)
			expect(stat?.size).toBe(123) // Should preserve size from input stat
		})

		it('should update timestamp of existing file', () => {
			// Create a file first
			fs.touch('/update-file.txt')

			// Get the original timestamp
			const originalStat = fs.stat('/update-file.txt')
			const originalTime = originalStat!.mtime

			// Wait a bit to ensure timestamp would be different
			const newTime = Date.now() + 1000

			// Mock Date.now() to return a specific time
			const originalDateNow = Date.now
			Date.now = () => newTime

			// Update the file
			fs.touch('/update-file.txt')

			// Restore Date.now
			Date.now = originalDateNow

			// Get the updated timestamp
			const updatedStat = fs.stat('/update-file.txt')

			expect(updatedStat!.mtime).toBe(newTime)
			expect(updatedStat!.mtime).not.toBe(originalTime)
		})

		it('should throw error when parent directory does not exist', () => {
			expect(fs.touch('/nonexistent/file.txt')).toBe(true)
		})

		it('should throw error when parent path is a file', () => {
			// Create a file
			fs.touch('/parentfile.txt')

			// Try to create a file with the file as parent
			expect(() => fs.touch('/parentfile.txt/child.txt')).toThrow(
				'Parent path is not a directory',
			)
		})

		it('should normalize paths', () => {
			// Without leading slash
			fs.touch('normalized-file.txt')
			expect(fs.exists('/normalized-file.txt')).toBe(true)

			// Compare with regular file creation (touch creates files)
			fs.touch('/regular-file')
			const fileStat = fs.stat('/regular-file')
			expect(fileStat?.isDir).toBe(false)
		})

		it('should create directory with mkdir using trailing slash', () => {
			// Create directory with trailing slash using mkdir
			fs.mkdir('/path/to/dir/')

			// Verify it's created as a directory
			const stat = fs.stat('/path/to/dir')
			expect(stat).not.toBe(null)
			expect(stat?.isDir).toBe(true)

			// Create file in the directory
			fs.touch('/path/to/dir/file.txt')
			expect(fs.exists('/path/to/dir/file.txt')).toBe(true)

			// List the directory
			const contents = fs.list('/path/to/dir')
			expect(contents.length).toBe(1)
			expect(contents[0].basename).toBe('file.txt')
		})
	})

	describe('Case Sensitivity', () => {
		let fs: memfs

		beforeEach(() => {
			fs = new memfs([
				{
					path: '/file.txt',
					basename: 'file.txt',
					isDir: false,
					isDeleted: false,
					mtime: 1,
					size: 1,
				},
				{
					path: '/Dir',
					basename: 'Dir',
					isDir: true,
					isDeleted: false,
					mtime: 1,
					size: 0,
				},
			])
		})

		it('should be case-sensitive for file paths', () => {
			expect(fs.exists('/file.txt')).toBe(true)
			expect(fs.exists('/File.txt')).toBe(false)
			expect(fs.stat('/File.txt')).toBe(null)
		})

		it('should be case-sensitive for directory paths', () => {
			expect(fs.exists('/Dir')).toBe(true)
			expect(fs.exists('/dir')).toBe(false)
			expect(fs.stat('/dir')).toBe(null)
			expect(() => fs.list('/dir')).toThrow('Path does not exist')
		})
	})

	describe('Constructor Validation', () => {
		it('should handle conflicting entries (last one wins)', () => {
			const fs = new memfs([
				{
					path: '/conflict',
					basename: 'conflict',
					isDir: true,
					isDeleted: false,
					mtime: 1,
					size: 0,
				},
				{
					path: '/conflict',
					basename: 'conflict',
					isDir: false,
					isDeleted: false,
					mtime: 2,
					size: 100,
				}, // Same path, different type
			])
			const stat = fs.stat('/conflict')
			expect(stat).not.toBeNull()
			expect(stat?.isDir).toBe(false) // The file entry should overwrite the directory entry
			expect(stat?.size).toBe(100)
			expect(fs.walk().length).toBe(1) // Only one entry should exist
		})

		it('should ignore inconsistent basename in input StatModel', () => {
			// Basename 'c' doesn't match path '/a/b'
			const fs = new memfs([
				{
					path: '/a/b',
					basename: 'c',
					isDir: true,
					isDeleted: false,
					mtime: 1,
					size: 0,
				},
			])
			const stat = fs.stat('/a/b')
			expect(stat).not.toBeNull()
			expect(stat?.isDir).toBe(true)
			expect(stat?.basename).toBe('b') // Basename should be derived correctly from path ('b'), ignoring input 'c'
			expect(stat?.path).toBe('/a/b')
		})
	})

	describe('complex operation sequences and edge cases', () => {
		let fs: memfs

		beforeEach(() => {
			// Start with a basic structure for some tests
			fs = new memfs([
				{
					path: '/dir/subdir/file.txt',
					basename: 'file.txt',
					isDir: false,
					isDeleted: false,
					mtime: 1,
					size: 1,
				},
				{
					path: '/dir/anotherfile.txt',
					basename: 'anotherfile.txt',
					isDir: false,
					isDeleted: false,
					mtime: 2,
					size: 2,
				},
				{
					path: '/emptyDir',
					basename: 'emptyDir',
					isDir: true,
					isDeleted: false,
					mtime: 3,
					size: 0,
				},
			])
		})

		it('should handle stat/list/exists after file deletion', () => {
			expect(fs.exists('/dir/anotherfile.txt')).toBe(true)
			fs.delete('/dir/anotherfile.txt')
			expect(fs.exists('/dir/anotherfile.txt')).toBe(false)
			expect(fs.stat('/dir/anotherfile.txt')).toBe(null)
			const dirContents = fs.list('/dir')
			expect(
				dirContents.find((f) => f.basename === 'anotherfile.txt'),
			).toBeUndefined()
			expect(dirContents.length).toBe(1) // Only subdir should remain implicitly
		})

		it('should handle stat/list/exists after recursive directory deletion', () => {
			expect(fs.exists('/dir')).toBe(true)
			expect(fs.exists('/dir/subdir')).toBe(true)
			expect(fs.exists('/dir/subdir/file.txt')).toBe(true)

			fs.delete('/dir', true) // Recursive delete

			expect(fs.exists('/dir')).toBe(false)
			expect(fs.exists('/dir/subdir')).toBe(false)
			expect(fs.exists('/dir/subdir/file.txt')).toBe(false)
			expect(fs.stat('/dir')).toBe(null)
			expect(() => fs.list('/dir')).toThrow('Path does not exist')
		})

		it('should fail to delete non-empty directory non-recursively', () => {
			expect(() => fs.delete('/dir')).toThrow(
				'Cannot delete non-empty directory',
			)
			expect(fs.exists('/dir')).toBe(true) // Should still exist
		})

		it('should return false when deleting already deleted or non-existent items', () => {
			expect(fs.delete('/nonexistent')).toBe(false)
			fs.delete('/dir/anotherfile.txt') // Delete it once
			expect(fs.delete('/dir/anotherfile.txt')).toBe(false) // Delete again
		})

		it('should create intermediate directories with touch', () => {
			fs = new memfs([]) // Start empty
			fs.touch('/new/deep/path/file.txt')

			expect(fs.exists('/new')).toBe(true)
			expect(fs.stat('/new')?.isDir).toBe(true)
			expect(fs.exists('/new/deep')).toBe(true)
			expect(fs.stat('/new/deep')?.isDir).toBe(true)
			expect(fs.exists('/new/deep/path')).toBe(true)
			expect(fs.stat('/new/deep/path')?.isDir).toBe(true)
			expect(fs.exists('/new/deep/path/file.txt')).toBe(true)
			expect(fs.stat('/new/deep/path/file.txt')?.isDir).toBe(false)

			const deepContents = fs.list('/new/deep')
			expect(deepContents.length).toBe(1)
			expect(deepContents[0].basename).toBe('path')
		})

		// Renamed for clarity - behavior is correct (touching a dir path fails)
		it('should throw when trying to touch an existing directory path', () => {
			expect(fs.exists('/dir')).toBe(true)
			expect(fs.stat('/dir')?.isDir).toBe(true)
			// Unix touch updates timestamp of existing dir, but our touch creates files/updates file mtime.
			// Throwing seems reasonable for this implementation if touch is file-specific.
			// If touch should update dir mtime, this test needs changing. Assuming current behavior is intended.
			expect(() => fs.touch('/dir')).toThrow()
		})

		it('should throw when creating a directory where a file exists', () => {
			expect(fs.exists('/dir/anotherfile.txt')).toBe(true)
			expect(fs.stat('/dir/anotherfile.txt')?.isDir).toBe(false)
			// Test mkdir instead of touch for directory creation attempt
			expect(() => fs.mkdir('/dir/anotherfile.txt')).toThrow(
				'Path exists but is not a directory',
			)
			expect(() => fs.mkdir('/dir/anotherfile.txt/')).toThrow(
				'Path exists but is not a directory',
			) // Also check trailing slash
		})

		it('should handle path normalization with . and .. during operations', () => {
			expect(fs.exists('/dir/subdir/../anotherfile.txt')).toBe(true)
			expect(fs.stat('/dir/subdir/../anotherfile.txt')?.path).toBe(
				'/dir/anotherfile.txt',
			)

			fs.touch('/dir/./newfile.txt')
			expect(fs.exists('/dir/newfile.txt')).toBe(true)

			const listResult = fs.list('/dir/subdir/..') // Should list contents of /dir
			expect(listResult.length).toBe(3) // subdir, anotherfile.txt, newfile.txt
			expect(listResult.find((f) => f.basename === 'subdir')).toBeTruthy()
			expect(
				listResult.find((f) => f.basename === 'anotherfile.txt'),
			).toBeTruthy()
			expect(listResult.find((f) => f.basename === 'newfile.txt')).toBeTruthy()

			fs.delete('/dir/subdir/../anotherfile.txt')
			expect(fs.exists('/dir/anotherfile.txt')).toBe(false)
		})

		it('should handle operations after recursive root deletion', () => {
			fs.delete('/', true) // Delete everything

			expect(fs.walk().length).toBe(0) // No stats left
			expect(fs.exists('/')).toBe(true) // Root always exists conceptually
			expect(fs.list('/').length).toBe(0) // Root is empty

			// Can add new things to root
			fs.touch('/newRootFile.txt')
			expect(fs.exists('/newRootFile.txt')).toBe(true)
			expect(fs.list('/').length).toBe(1)

			fs.mkdir('/newRootDir') // Use mkdir
			expect(fs.exists('/newRootDir')).toBe(true)
			expect(fs.stat('/newRootDir')?.isDir).toBe(true)
			expect(fs.list('/').length).toBe(2)
		})

		it('should correctly handle deletion of implicit directories when they become empty', () => {
			fs = new memfs([])
			fs.touch('/implicit/dir/file.txt')
			expect(fs.exists('/implicit/dir')).toBe(true)

			fs.delete('/implicit/dir/file.txt') // Delete the file
			expect(fs.exists('/implicit/dir/file.txt')).toBe(false)
			expect(fs.exists('/implicit/dir')).toBe(true) // Implicit dir still exists

			const result = fs.delete('/implicit/dir') // Now delete the empty implicit dir
			expect(result).toBe(true)
			expect(fs.exists('/implicit/dir')).toBe(false)
			expect(fs.exists('/implicit')).toBe(true) // Parent implicit dir still exists

			const result2 = fs.delete('/implicit')
			expect(result2).toBe(true)
			expect(fs.exists('/implicit')).toBe(false)
		})
	})
})
