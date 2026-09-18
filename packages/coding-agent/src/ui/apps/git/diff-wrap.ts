import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";

/** A half-open interval of display columns in the original line. */
export interface WrapSpan {
	readonly start: number;
	readonly end: number;
}

// Vim's `breakat` plus closing brackets. Keep apostrophes, backticks, and sigils attached.
const BREAK_AFTER = /[!@*\-+;:,./?)\]}]/;
const DIGIT = /^\d$/;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Greedy word wrap. Break whitespace drops out; tokens wider than a row break between graphemes. */
export function wrapDiffLine(text: string, width: number): WrapSpan[] {
	const fit = visibleWidth(text);
	if (fit <= width) return [{ start: 0, end: fit }];
	const segments = Array.from(graphemes.segment(text), part => part.segment);
	let total = 0;
	const clusters = segments.map((segment, index) => {
		const col = total;
		const cells = visibleWidth(segment);
		total += cells;
		const betweenDigits = DIGIT.test(segments[index - 1] ?? "") && DIGIT.test(segments[index + 1] ?? "");
		return {
			col,
			cells,
			blank: cells > 0 && segment.trim() === "",
			breakAfter: cells > 0 && !betweenDigits && BREAK_AFTER.test(segment),
		};
	});
	const spans: WrapSpan[] = [];
	let index = 0;
	while (index < clusters.length) {
		// Drop break whitespace, but keep the line's own leading indentation.
		if (index > 0) while (clusters[index]?.blank) index++;
		if (index >= clusters.length) break;
		const start = clusters[index]!.col;
		let end = index;
		let hasContent = false;
		let breakEnd = -1;
		let breakNext = -1;
		while (end < clusters.length) {
			const cluster = clusters[end]!;
			if (end > index && cluster.col + cluster.cells - start > width) break;
			if (cluster.blank) {
				if (hasContent && !clusters[end - 1]?.blank) {
					breakEnd = cluster.col;
					breakNext = end;
				}
			} else {
				hasContent = true;
				if (cluster.breakAfter) {
					breakEnd = cluster.col + cluster.cells;
					breakNext = end + 1;
				}
			}
			end++;
		}
		if (end === clusters.length) {
			spans.push({ start, end: total });
			break;
		}
		if (breakNext > index) {
			spans.push({ start, end: breakEnd });
			index = breakNext;
		} else {
			spans.push({ start, end: clusters[end]!.col });
			index = end;
		}
	}
	return spans;
}
