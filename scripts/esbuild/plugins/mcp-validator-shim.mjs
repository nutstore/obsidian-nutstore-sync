import path from 'node:path'

const MCP_AJV_PROVIDER_FILTER =
	/node_modules[\\/]@modelcontextprotocol[\\/]sdk[\\/]dist[\\/](?:esm|cjs)[\\/]validation[\\/]ajv-provider\.js$/

/**
 * `@modelcontextprotocol/sdk`'s `Client` statically imports `AjvJsonSchemaValidator`
 * as a default fallback even when callers supply their own validator or use
 * `@cfworker/json-schema`. That single fallback pulls in `ajv`, `ajv-formats`,
 * `fast-uri`, `json-schema-traverse` and `fast-deep-equal` (~133 KB) plus
 * `new Function` codegen. Redirect it to the SDK's own `cfworker-provider`,
 * backed by `@cfworker/json-schema` which is already bundled.
 */
export function mcpValidatorShimPlugin() {
	return {
		name: 'mcp-validator-shim',
		setup(build) {
			build.onLoad({ filter: MCP_AJV_PROVIDER_FILTER }, (args) => ({
				contents: [
					`import { CfWorkerJsonSchemaValidator } from './cfworker-provider.js'`,
					`export class AjvJsonSchemaValidator extends CfWorkerJsonSchemaValidator {`,
					`\tconstructor() {`,
					`\t\tsuper({ shortcircuit: false })`,
					`\t}`,
					`}`,
				].join('\n'),
				loader: 'js',
				resolveDir: path.dirname(args.path),
				watchFiles: [args.path],
			}))
		},
	}
}
