import { Subject } from 'rxjs'

interface SsoRxProps {
	token: string
}

const ssoReceive = new Subject<SsoRxProps>()

export const onSsoReceive = () => ssoReceive.asObservable()
export const emitSsoReceive = (props: SsoRxProps) => ssoReceive.next(props)
