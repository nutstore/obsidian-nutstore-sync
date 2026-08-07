export const VAULT_MOUNT_POINT = '/vault'
export const AGENTS_MOUNT_POINT = '/.agents'
export const AGENTS_VAULT_PATH = '.agents'
export const NUTSTORE_SYNC_AGENTS_MOUNT_POINT = `${AGENTS_MOUNT_POINT}/nutstore-sync`
export const NUTSTORE_SYNC_AGENTS_VAULT_PATH = `${AGENTS_VAULT_PATH}/nutstore-sync`
export const BASH_TMP_MOUNT_POINT = '/tmp'
export const BASH_TMP_VAULT_PATH = `${NUTSTORE_SYNC_AGENTS_VAULT_PATH}/tmp`
export const BUILTIN_SKILLS_MOUNT_POINT = `${NUTSTORE_SYNC_AGENTS_MOUNT_POINT}/builtin-skills`
export const BUILTIN_SKILLS_RELATIVE_MOUNT_POINT =
	'/nutstore-sync/builtin-skills'
