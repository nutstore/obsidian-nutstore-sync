export interface FolderProps {
	name: string
	path: string
	onClick: (path: string) => void
}

function Folder(props: FolderProps) {
	return (
		<div
			class="flex gap-2 items-center max-w-full hover:bg-[var(--interactive-accent)] border-rounded px-1"
			onClick={() => props.onClick(props.path)}
		>
			<div class="i-custom:folder size-10" />
			<span class="truncate flex-1">{props.name}</span>
		</div>
	)
}

export default Folder
