export interface FolderProps {
	name: string
}

function File(props: FolderProps) {
	return (
		<div class="flex gap-2 items-center max-w-full border-rounded px-1 hover:cursor-not-allowed opacity-20">
			<div class="i-custom:file size-10" />
			<span class="truncate flex-1">{props.name}</span>
		</div>
	)
}

export default File
