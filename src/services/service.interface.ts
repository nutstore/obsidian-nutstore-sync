export abstract class BaseService {
	onload(): void | Promise<void> {}
	onunload(): void {}
}
