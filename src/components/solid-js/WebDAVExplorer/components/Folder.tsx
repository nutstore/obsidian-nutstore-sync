export interface FolderProps {
	name: string
	path: string
	onClick: (path: string) => void
}

function Folder(props: FolderProps) {
	return (
		<div
			class=":uno: flex gap-2 items-center max-w-full hover:bg-[var(--interactive-accent)] border-rounded px-1"
			onClick={() => props.onClick(props.path)}
		>
			<div class=":uno: i-custom:folder size-10" />
			<span class=":uno: truncate flex-1">{props.name}</span>
		</div>
	)
}

export default Folder
