import { Subject } from 'rxjs'

interface VaultEventProps {
	type: string
}

const vaultEvent = new Subject<VaultEventProps>()

export const onVaultEvent = () => vaultEvent.asObservable()
export const emitVaultEvent = (props: VaultEventProps) => vaultEvent.next(props)
