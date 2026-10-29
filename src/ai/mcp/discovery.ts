/** Curated connection drafts only. Installed servers remain in mcp.json. */
export const MCP_DISCOVERY_SERVERS = [
	{
		id: 'exa',
		name: 'Exa',
		icon: 'search',
		url: 'https://mcp.exa.ai/mcp',
		website: 'https://exa.ai/mcp',
		auth: 'noKey',
	},
	{
		id: 'deepwiki',
		name: 'DeepWiki',
		icon: 'book-open',
		url: 'https://mcp.deepwiki.com/mcp',
		website: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
		auth: 'noKey',
	},
	{
		id: 'tavily',
		name: 'Tavily',
		icon: 'globe',
		url: 'https://mcp.tavily.com/mcp/',
		website: 'https://docs.tavily.com/documentation/mcp',
		auth: 'requiresKey',
	},
	{
		id: 'context7',
		name: 'Context7',
		icon: 'code-xml',
		url: 'https://mcp.context7.com/mcp',
		website: 'https://context7.com/docs',
		auth: 'optionalKey',
	},
] as const
