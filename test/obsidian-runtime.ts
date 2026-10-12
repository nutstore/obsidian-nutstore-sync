/**
 * The Obsidian package ships declarations; the host supplies its runtime.
 * Resolve it in unit tests so each test can explicitly mock the native API
 * members it needs instead of loading an unavailable application runtime.
 */
export {}
