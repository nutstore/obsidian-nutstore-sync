export function classTokens(...classNames: string[]): string[] {
	return classNames.flatMap((className) =>
		className.split(/\s+/).filter(Boolean),
	)
}

export function addClassTokens(
	element: Element,
	...classNames: string[]
): void {
	element.classList.add(...classTokens(...classNames))
}

export function removeClassTokens(
	element: Element,
	...classNames: string[]
): void {
	element.classList.remove(...classTokens(...classNames))
}

export function toggleClassTokens(
	element: Element,
	className: string,
	force: boolean,
): void {
	for (const token of classTokens(className)) {
		element.classList.toggle(token, force)
	}
}
