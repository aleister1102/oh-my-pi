/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A user-invoked skill: a user-toned card headed by the skill chip (linked to
 * its SKILL.md) and the prompt's size, the user's draft always visible, and
 * the loaded skill prompt behind a disclosure.
 *
 * The terminal draws one of two layouts, chosen by where `/skill:<name>` sat
 * in the draft: a callout with a skill-colored rail when it led the draft
 * (the chip and size head it, the rest of the draft under them), or the
 * draft as a plain user bubble with the chip inline when it sat mid-prompt
 * (the callout then only holds the expanded prompt).
 *
 * Terminal look: `omp.skill` (`src/ui/styles/messages/skill.ts`).
 */
import type { JSXNode, Reactive } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { allowsSkillTokens, SKILL_TOKEN_RE } from "../../../extensibility/skill-tokens";
import type { SkillPromptDetails } from "../../../session/transcript/messages";
import { cardExpansion } from "../expansion";
import { chipText, skillChipLabel, termChips } from "./chips";
import { openableImage } from "./image";

/** What a skill row shows. */
export interface SkillMessageProps {
	readonly content: string | readonly { readonly type: string; readonly text?: string }[];
	readonly details?: Partial<SkillPromptDetails>;
	/** Files of attached images by chip number − 1. */
	readonly imageLinks?: readonly (string | undefined)[];
	readonly expanded: Reactive<boolean>;
	readonly onToggle?: (expanded: boolean) => void;
}

function promptText(content: SkillMessageProps["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap(part => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");
}

/** A skill invocation. */
export function SkillMessage(props: SkillMessageProps): JSXNode {
	const details = props.details;
	const loaded = details?.skills?.length
		? details.skills
		: [{ name: details?.name?.trim() || "unknown", path: details?.path, lineCount: details?.lineCount }];
	const byName = new Map(loaded.map(skill => [skill.name, skill]));
	const token = `/skill:${loaded[0]!.name}`;
	const prompt = details?.prompt ?? (details?.args ? `${token} ${details.args}` : token);
	const canChip = allowsSkillTokens(prompt);
	const leadingSkills = new Set<string>();
	let draftStart = 0;
	if (canChip) {
		for (const match of prompt.matchAll(SKILL_TOKEN_RE)) {
			const name = match[2]!;
			const tokenStart = match.index + match[1]!.length;
			const between = prompt.slice(draftStart, tokenStart);
			if (
				(draftStart === 0 ? between !== "" : between.trim() !== "") ||
				!byName.has(name) ||
				leadingSkills.has(name)
			) {
				break;
			}
			leadingSkills.add(name);
			draftStart = match.index + match[0].length;
		}
	}
	const leading = leadingSkills.size > 0;
	const remaining = leading ? prompt.slice(draftStart).trim() : prompt;
	// Only loaded skills become chips; other tokens stay literal.
	const draft = canChip
		? remaining.replace(SKILL_TOKEN_RE, (match, delimiter: string, name: string) =>
				byName.has(name) ? `${delimiter}${skillChipLabel(name)}` : match,
			)
		: remaining;
	const headerSkills = leading ? [...leadingSkills].map(name => byName.get(name)!) : loaded;
	const header = headerSkills.map(skill => ({
		label: skillChipLabel(skill.name),
		path: skill.path,
		lines:
			typeof skill.lineCount === "number"
				? `${skill.lineCount} ${skill.lineCount === 1 ? "line" : "lines"}`
				: undefined,
	}));
	const head: TspSpan[] = [];
	for (const { label, path, lines } of header) {
		const href = path ? openableImage(path).href : undefined;
		if (head.length > 0) head.push({ t: "  " });
		head.push(
			href ? { t: label, s: "customMessageLabel strong", href } : { t: label, s: "customMessageLabel strong" },
		);
		if (lines) head.push({ t: `  ${lines}`, s: "muted" });
	}
	const text = promptText(props.content);
	const chips = chipText(draft, {
		imageLinks: props.imageLinks,
		skillPath: candidate => byName.get(candidate)?.path,
	});
	const { expanded, toggle } = cardExpansion(props.expanded, props.onToggle);
	return (
		<card
			role="omp.skill"
			tone="user"
			head={head}
			term={() => ({
				header,
				leading,
				draft: chips.text,
				chips: termChips(chips.chips),
				prompt: text,
				expanded: expanded(),
			})}
		>
			{draft && <md text={draft} />}
			<section
				key="prompt"
				head={[{ t: "prompt", s: "muted" }]}
				role="omp.skill.prompt"
				collapsible
				collapsed={() => !expanded()}
				onToggle={toggle}
			>
				{() => expanded() && text && <md text={text} />}
			</section>
		</card>
	);
}
