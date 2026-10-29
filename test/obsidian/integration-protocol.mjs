/**
 * Vault-relative mailbox shared by the guest harness and its external runner.
 * Test results are independent of Obsidian's configurable settings directory.
 * A root-level hidden file needs no setup and survives plugin reloads.
 */
export const OBSIDIAN_E2E_RESULT_PATH = '.nutstore-sync-e2e-result.json'
