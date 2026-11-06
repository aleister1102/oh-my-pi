import { effect, type KeyEvent, onCleanup, signal, type TextEdit, untrack } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { TspEditorDecoration } from "@oh-my-pi/pi-wire";
import { getKeybindings } from "../../config/keybindings/keybindings";
import { MacOSSpellingProvider, type MacOSSpellingFeatures } from "../../modes/view-model/prompt/macos-spelling";
import { PROVISIONAL_SPACE_ABSORBERS } from "../../modes/view-model/prompt/typing-word";
import { type WordCompletionMethod, WordCompletionProvider } from "../../modes/view-model/prompt/word-completion";
import { textPredictionBackend } from "../../predict/client";

export interface TextAssistFeatures extends Partial<MacOSSpellingFeatures> {
	readonly autocomplete?: WordCompletionMethod;
}

interface FieldValue {
	readonly text: string;
	readonly cursor: number;
}

interface TextAssistOptions {
	/** A stable snapshot; replacement replies are valid only for this same object. */
	value(): FieldValue;
	apply(edit: TextEdit): void;
	features(): TextAssistFeatures;
	active?(): boolean;
	/** Distinguishes fields when one assist instance follows a dialog's focus. */
	scope?(): string | undefined;
}

interface Replacements {
	readonly value: FieldValue;
	readonly from: number;
	readonly to: number;
	readonly items: readonly string[];
	readonly selected: number;
}

const WORD_END = /^[\s.,;:!?"\])}]$/u;
const WORD_CHAR = /[\p{L}\p{M}']/u;

function position({ text, cursor }: FieldValue): { lines: string[]; line: number; col: number } {
	const before = text.slice(0, cursor).split("\n");
	return { lines: text.split("\n"), line: before.length - 1, col: before.at(-1)!.length };
}

/** Describe a fallback key edit only when it actually inserted the key's printable text. */
export function textEditForKey(before: FieldValue, after: FieldValue, key: KeyEvent): TextEdit | undefined {
	const { cursor, text: value } = before;
	const text = key.text;
	if (
		!text ||
		after.cursor !== cursor + text.length ||
		after.text !== value.slice(0, cursor) + text + value.slice(cursor)
	)
		return undefined;
	return { from: cursor, to: cursor, text, cursor: after.cursor, len: value.length };
}

/** Prose assistance for a controlled editor or input, without taking over its submit, paste, or undo. */
export function createTextAssist(options: TextAssistOptions) {
	const words = new WordCompletionProvider(textPredictionBackend);
	let spelling: MacOSSpellingProvider | undefined;
	const spellingRevision = signal(0);
	const pendingChoices = signal<Replacements | undefined>(undefined);
	let provisional: FieldValue | undefined;
	let generation = 0;
	let disposed = false;
	onCleanup(() => {
		disposed = true;
		words.setMethod("off");
		if (spelling) spelling.onUpdate = undefined;
	});

	const active = () => !disposed && (options.active?.() ?? true);
	const context = () => (active() ? (options.scope?.() ?? true) : false);
	let previousContext = untrack(context);
	effect(() => {
		const next = context();
		if (next === previousContext) return;
		previousContext = next;
		generation++;
		provisional = undefined;
		words.setMethod("off");
		pendingChoices.set(undefined);
	});
	const service = () => {
		const { typoDetection = false, autocorrect = false } = options.features();
		if (!typoDetection && !autocorrect) return undefined;
		if (!spelling) {
			spelling = new MacOSSpellingProvider();
			spelling.onUpdate = () => spellingRevision.update(value => value + 1);
		}
		spelling.setFeatures({ typoDetection, autocorrect });
		return spelling;
	};
	const ghost = (): string | undefined => {
		if (!active()) return undefined;
		words.setMethod(options.features().autocomplete ?? "off");
		words.revision();
		const { lines, line, col } = position(options.value());
		if (col !== lines[line]?.length) return undefined;
		const suffix = words.getWordCompletion(lines, line, col);
		return (suffix && stripEscapes(suffix).replace(/[\x00-\x1f\x7f]/g, "")) || undefined;
	};
	const decor = (): readonly TspEditorDecoration[] | undefined => {
		if (!active() || !options.features().typoDetection) return undefined;
		const checker = service();
		if (!checker) return undefined;
		spellingRevision();
		const value = options.value();
		const { lines, line, col } = position(value);
		const at = lines[line] ?? "";
		let start = col;
		let end = col;
		while (start > 0 && WORD_CHAR.test(at[start - 1]!)) start--;
		while (end < at.length && WORD_CHAR.test(at[end]!)) end++;
		const typing = start < end ? { line, start, end } : undefined;
		let offset = 0;
		const out: TspEditorDecoration[] = [];
		for (const [index, content] of lines.entries()) {
			for (const range of checker.typoRanges(content, {
				editorText: value.text,
				lines,
				line: index,
				startCol: 0,
				typing,
			})) {
				out.push({ from: offset + range.start, to: offset + range.start + range.length, s: "typo" });
			}
			offset += content.length + 1;
		}
		return out.length > 0 ? out : undefined;
	};
	const sameValue = (left: FieldValue, right: FieldValue) => left.text === right.text && left.cursor === right.cursor;
	const current = (value: FieldValue, epoch: number) => generation === epoch && active() && options.value() === value;
	const replace = (value: FieldValue, from: number, to: number, text: string) =>
		options.apply({ from, to, text, cursor: from + text.length, len: value.text.length });
	const suggestions = () => {
		const choices = pendingChoices();
		return choices && active() && options.features().typoDetection && options.value() === choices.value
			? choices
			: undefined;
	};
	const choose = (index: number) => {
		const choices = untrack(suggestions);
		const item = choices?.items[index];
		if (!choices || item === undefined) return;
		pendingChoices.set(undefined);
		replace(choices.value, choices.from, choices.to, item);
	};

	const handleKey = (key: KeyEvent): boolean =>
		untrack(() => {
			if (key.kind === "release" || !active()) return false;
			const epoch = ++generation;
			const choices = suggestions();
			if (choices) {
				if (key.id === "up" || key.id === "down") {
					const step = key.id === "up" ? -1 : 1;
					pendingChoices.set({
						...choices,
						selected: (choices.selected + step + choices.items.length) % choices.items.length,
					});
					return true;
				}
				if (key.id === "enter" || key.id === "tab") {
					choose(choices.selected);
					return true;
				}
				pendingChoices.set(undefined);
				if (key.id === "escape") return true;
			}
			const bindings = getKeybindings();
			const value = options.value();
			const tab = bindings.matches(key, "tui.input.tab");
			const right = bindings.matches(key, "tui.editor.cursorRight");
			if (tab || right) {
				provisional = undefined;
				const suffix = ghost();
				if (!suffix) return false;
				const { lines, line, col } = position(value);
				words.wordCompletionFeedback(lines, line, col, suffix, true);
				const text = tab ? `${suffix} ` : suffix;
				replace(value, value.cursor, value.cursor, text);
				const next = options.value();
				if (tab && next !== value && next.text[next.cursor - 1] === " ") provisional = next;
				return true;
			}
			if (!key.text) provisional = undefined;
			if (!bindings.matches(key, "tui.editor.spellingSuggestions") || !options.features().typoDetection)
				return false;
			const checker = service();
			if (!checker) return false;
			const { lines, line, col } = position(value);
			void checker.getWordReplacements(lines, line, col).then(found => {
				if (!found?.items.length || !current(value, epoch) || !options.features().typoDetection) return;
				const offset = value.cursor - col;
				pendingChoices.set({
					value,
					from: offset + found.startCol,
					to: offset + found.endCol,
					items: found.items,
					selected: 0,
				});
			});
			return true;
		});

	/** Observe a UI edit. Synthetic edits are applied without reentering this path. */
	const edit = (event: TextEdit, apply: (edit: TextEdit) => void, typed = true): void =>
		untrack(() => {
			const epoch = ++generation;
			const before = options.value();
			const space = provisional === before;
			provisional = undefined;
			pendingChoices.set(undefined);
			if (
				!active() ||
				!typed ||
				event.len !== before.text.length ||
				event.from !== before.cursor ||
				event.to !== event.from ||
				!event.text
			) {
				apply(event);
				return;
			}
			if (space && event.text === " ") return;
			const suggestion = ghost();
			if (suggestion) {
				const overlap = Math.min(suggestion.length, event.text.length);
				if (suggestion.slice(0, overlap).toLocaleLowerCase() !== event.text.slice(0, overlap).toLocaleLowerCase()) {
					const { lines, line, col } = position(before);
					words.wordCompletionFeedback(lines, line, col, suggestion, false);
				}
			}
			apply(
				space && PROVISIONAL_SPACE_ABSORBERS.test(event.text)
					? { ...event, from: event.from - 1, cursor: event.cursor - 1 }
					: event,
			);
			const value = options.value();
			if (!WORD_END.test(event.text) || sameValue(value, before) || !options.features().autocorrect) return;
			const checker = service();
			if (!checker) return;
			const { lines, line, col } = position(value);
			void checker.tryAutocorrect(lines, line, col).then(replacement => {
				if (!replacement || !current(value, epoch) || !options.features().autocorrect) return;
				const from = value.cursor - replacement.replaceLen;
				if (from >= 0) replace(value, from, value.cursor, replacement.insert);
			});
		});

	return { ghost, decor, handleKey, edit, suggestions, choose };
}
