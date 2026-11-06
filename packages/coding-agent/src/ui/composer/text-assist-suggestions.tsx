/** @jsxImportSource @oh-my-pi/pi-tui */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { createTextAssist } from "./text-assist";

export function TextAssistSuggestions(props: { readonly assist: ReturnType<typeof createTextAssist> }): JSXNode {
	const choices = props.assist.suggestions();
	if (!choices) return null;
	return (
		<list
			key="spelling"
			role="omp.spelling.suggestions"
			selected={String(choices.selected)}
			onActivate={item => props.assist.choose(Number(item))}
		>
			{choices.items.map((item, index) => (
				<item key={String(index)} label={item} />
			))}
		</list>
	);
}
