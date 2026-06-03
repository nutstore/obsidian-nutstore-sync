import { Subject } from 'rxjs'

export interface NutstoreLlmGatewayAuthEvent {
	status: 'authorizing' | 'idle'
}

const nutstoreLlmGatewayAuth = new Subject<NutstoreLlmGatewayAuthEvent>()

export const onNutstoreLlmGatewayAuth = () =>
	nutstoreLlmGatewayAuth.asObservable()
export const emitNutstoreLlmGatewayAuth = (
	event: NutstoreLlmGatewayAuthEvent,
) => nutstoreLlmGatewayAuth.next(event)
