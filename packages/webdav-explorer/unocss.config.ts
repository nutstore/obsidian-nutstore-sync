import { defineConfig, presetIcons, presetUno } from 'unocss'

export default defineConfig({
	content: {
		filesystem: ['**/*.{html,js,ts,jsx,tsx,vue,svelte,astro}'],
	},
	rules: [
		[
			/^scrollbar-hide$/,
			([_]) => {
				return `.scrollbar-hide{scrollbar-width:none}
  .scrollbar-hide::-webkit-scrollbar{display:none}`
			},
		],
		[
			/^scrollbar-default$/,
			([_]) => {
				return `.scrollbar-default{scrollbar-width:auto}
  .scrollbar-default::-webkit-scrollbar{display:block}`
			},
		],
	],
	presets: [
		presetIcons({
			collections: {
				custom: {
					folder:
						'<svg id="图层_1" data-name="图层 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><title>folder</title><path d="M396.5,185.7l22.7,27.2a36.1,36.1,0,0,0,27.7,12.7H906.8c29.4,0,53.2,22.8,53.2,50.9V800.1c0,28.1-23.8,50.9-53.2,50.9H117.2C87.8,851,64,828.2,64,800.1V223.9c0-28.1,23.8-50.9,53.2-50.9H368.8A36.1,36.1,0,0,1,396.5,185.7Z" style="fill:#9fddff"/><path d="M64,342.5V797.8c0,29.4,24,53.2,53.6,53.2H906.4c29.6,0,53.6-23.8,53.6-53.2V342.5Z" style="fill:#74c6ff"/></svg>',
					file: '<svg id="图层_1" data-name="图层 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><title>unknown</title><path d="M186.9,64c-18.4,0-33.4,14.7-33.4,32.6V927.4c0,17.9,15,32.6,33.4,32.6H837.1c18.4,0,33.4-14.7,33.4-32.6V259.5L669.9,64Zm0,0" style="fill:#e3ecff"/><path d="M669.9,64V226.9c0,17.9,15,32.6,33.4,32.6H870.5Zm0,0" style="fill:#95a7cd"/><rect x="479.2" y="619.9" width="50" height="48.57" style="fill:#95a7cd"/><path d="M518.9,363.4h-6.1c-56.3,0-91.3,27.4-104,81.3l-1.3,5.6L450,464.3l1.3-7.1c6.9-36.9,25.7-54.1,59.3-54.1h4.6c28.1,2.6,42.8,15.6,46.2,40.6,2.6,20.4-10.1,40.2-37.7,58.9s-41.2,44-40.1,72.9v20.7h42.8V576.9c-.9-17.7,7.9-32.8,26.1-45,38.3-26.2,56.7-55.7,54.6-87.8C602.9,393.6,573.3,366.5,518.9,363.4Z" style="fill:#95a7cd"/></svg>',
				},
			},
		}),
		presetUno(),
	],
})
