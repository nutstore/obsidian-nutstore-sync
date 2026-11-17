export const DEFAULT_NS_NSDAV_ENDPOINT = process.env.NS_NSDAV_ENDPOINT!
export const DEFAULT_NS_DAV_ENDPOINT = process.env.NS_DAV_ENDPOINT!
/**
 * Version of the code in this build, injected from package.json by esbuild.
 * `manifest.json` is Obsidian install metadata and may drift; runtime identity
 * (settings card, logs, MCP client, exports) reports this value.
 */
export const PLUGIN_VERSION = process.env.PLUGIN_VERSION!
export const LLM_GATEWAY_CLIENT_ID = process.env.LLM_GATEWAY_CLIENT_ID!
export const NUTSTORE_LLM_GATEWAY_PROVIDER_ID = 'nutstore-llm-gateway'

export const IN_DEV = process.env.NODE_ENV === 'development'
