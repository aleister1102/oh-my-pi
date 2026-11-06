/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { createRoot, signal } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { SkillMessage, type SkillMessageProps } from "../../../../src/ui/transcript/messages/skill-message";
import { screenSuite, single } from "./harness";

screenSuite("skill-message", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: {
			content: SkillMessageProps["content"];
			details?: SkillMessageProps["details"];
		};
		imageLinks: string[];
	};
	const expanded = signal(false);
	return {
		node: single(
			<SkillMessage
				content={inputs.message.content}
				details={inputs.message.details}
				imageLinks={inputs.imageLinks}
				expanded={expanded}
			/>,
		),
		apply(label) {
			// `pending` holds an optimistic row live; it expands first and changes nothing visible.
			if (label === "expanded" || label === "pending") expanded.set(true);
			else if (label === "collapsed") expanded.set(false);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});

test("chips every loaded skill while leaving an unloaded token literal", () => {
	const env = staticEnvironment(loadThemeSync("dark"));
	const rows = createRoot(dispose => {
		try {
			const node = single(
				<SkillMessage
					content="Loaded skill prompts"
					details={{
						prompt: "/skill:atomic-commit  /skill:other-skill do work /skill:not-loaded",
						skills: [
							{ name: "atomic-commit", path: "/tmp/atomic-commit/SKILL.md", lineCount: 88 },
							{ name: "other-skill", path: "/tmp/other-skill/SKILL.md", lineCount: 12 },
						],
					}}
					expanded={false}
				/>,
			);
			return paintNode(env, node, 80).rows.map(stripEscapes);
		} finally {
			dispose();
		}
	});
	expect(rows.find(row => row.includes("✦ atomic-commit"))).toContain("88 lines  ✦ other-skill  12 lines");
	const text = rows.join("\n");
	expect(text).toContain("do work /skill:not-loaded");
	expect(text).not.toContain("/skill:atomic-commit");
	expect(text).not.toContain("/skill:other-skill");
});
