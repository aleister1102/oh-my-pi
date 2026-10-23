/**
 * Contracts for the trace transcript cache: append-only tail parsing (including
 * partial trailing lines), rewrite detection, compressed transcripts, entry-id
 * indexing, and the multi-session trace LRU.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildSessionTrace, getTraceEntry, truncateTraceTracks } from "@oh-my-pi/omp-stats/trace";
import type { TraceTrack } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-trace-cache-");

const T = 1_700_000_000_000;
const PROJECT = "--tmp--proj--";

const iso = (ms: number) => new Date(ms).toISOString();

const header = () => ({ type: "session", version: 3, id: "sess", timestamp: iso(T), cwd: "/tmp/proj" });

const user = (id: string, parentId: string | null, text: string, ts: number) => ({
	type: "message",
	id,
	parentId,
	timestamp: iso(ts),
	message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
});

const assistant = (id: string, parentId: string | null, ts: number) => ({
	type: "message",
	id,
	parentId,
	timestamp: iso(ts),
	message: {
		role: "assistant",
		model: "m-1",
		provider: "p",
		api: "openai-completions",
		timestamp: ts,
		duration: 500,
		completedAt: ts + 500,
		stopReason: "stop",
		content: [{ type: "text", text: "ok" }],
	},
});

const lines = (entries: unknown[]): string => `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;

async function writeRoot(name: string, entries: unknown[]): Promise<string> {
	const projectDir = path.join(getSessionsDir(), PROJECT);
	const file = path.join(projectDir, name);
	await fs.mkdir(projectDir, { recursive: true });
	await Bun.write(file, lines(entries));
	return file;
}

const turns = (trace: Awaited<ReturnType<typeof buildSessionTrace>>) =>
	trace.tracks[0].spans.filter(span => span.kind === "turn");

describe("transcript cache", () => {
	it("parses only appended lines and resumes a partial trailing line", async () => {
		const file = await writeRoot("1700000000000_cache.jsonl", [
			header(),
			user("u1", null, "first", T + 1000),
			assistant("a1", "u1", T + 2000),
		]);
		const initial = await buildSessionTrace(file);
		expect(turns(initial)).toHaveLength(1);

		const next = JSON.stringify(user("u2", "a1", "second", T + 3000));
		const cut = Math.floor(next.length / 2);
		await fs.appendFile(file, next.slice(0, cut));
		const partial = await buildSessionTrace(file);
		expect(turns(partial)).toHaveLength(1);
		expect(await getTraceEntry(file, "u2")).toBeNull();

		await fs.appendFile(file, `${next.slice(cut)}\n`);
		const complete = await buildSessionTrace(file);
		expect(turns(complete)).toHaveLength(2);
		expect(complete.tracks[0].spans.some(span => span.entryId === "u2")).toBe(true);
		expect(await getTraceEntry(file, "u2")).toMatchObject({ type: "message", id: "u2" });
	});

	it("detects a rewritten prefix instead of appending to stale entries", async () => {
		const file = await writeRoot("1700000000000_rewrite.jsonl", [
			header(),
			user("u1", null, "original-prefix", T + 1000),
			assistant("a1", "u1", T + 2000),
		]);
		const before = await buildSessionTrace(file);
		expect(turns(before).map(span => span.label)).toContain("original-prefix");

		await Bun.sleep(10);
		// Truncate and rewrite through the same handle so the inode is stable;
		// only the prefix checkpoint can catch this rewrite.
		const handle = await fs.open(file, "r+");
		try {
			await handle.truncate(0);
			await handle.writeFile(
				lines([
					header(),
					user("u1", null, "replacement-prefix-that-is-longer", T + 1000),
					assistant("a1", "u1", T + 2000),
					user("u2", "a1", "third", T + 3000),
					assistant("a2", "u2", T + 4000),
				]),
			);
		} finally {
			await handle.close();
		}
		const after = await buildSessionTrace(file);
		expect(after).not.toBe(before);
		const labels = turns(after).map(span => span.label);
		expect(labels).toContain("replacement-prefix-that-is-longer");
		expect(labels).not.toContain("original-prefix");
		expect(labels).toContain("third");
	});

	it("reuses a cached trace when switching back to an unchanged session", async () => {
		const first = await writeRoot("1700000000000_lru-a.jsonl", [
			header(),
			user("u1", null, "a", T + 1000),
			assistant("a1", "u1", T + 2000),
		]);
		const second = await writeRoot("1700000000000_lru-b.jsonl", [
			header(),
			user("u1", null, "b", T + 1000),
			assistant("a1", "u1", T + 2000),
		]);

		const traceA = await buildSessionTrace(first);
		const traceB = await buildSessionTrace(second);
		const traceAAgain = await buildSessionTrace(first);
		expect(traceB).not.toBe(traceA);
		expect(traceAAgain).toBe(traceA);
	});

	it("evicts the oldest trace beyond the LRU entry budget", async () => {
		const files: string[] = [];
		for (let i = 0; i < 9; i++) {
			files.push(
				await writeRoot(`17000000000${i}_lru.jsonl`, [
					header(),
					user("u1", null, `session-${i}`, T + 1000),
					assistant("a1", "u1", T + 2000),
				]),
			);
		}
		const traces: Array<Awaited<ReturnType<typeof buildSessionTrace>>> = [];
		for (const file of files) traces.push(await buildSessionTrace(file));

		// Nine distinct sessions exceed the eight-entry budget, so the first
		// must have been evicted rather than reused.
		expect(await buildSessionTrace(files[0])).not.toBe(traces[0]);
	});

	it("parses compressed transcripts and indexes their entries", async () => {
		const projectDir = path.join(getSessionsDir(), PROJECT);
		const file = path.join(projectDir, "1700000000000_gz.jsonl.gz");
		await fs.mkdir(projectDir, { recursive: true });
		const text = lines([header(), user("u1", null, "compressed", T + 1000), assistant("a1", "u1", T + 2000)]);
		await Bun.write(file, Bun.gzipSync(new TextEncoder().encode(text)));

		const trace = await buildSessionTrace(file);
		expect(turns(trace)).toHaveLength(1);
		expect(await getTraceEntry(file, "u1")).toMatchObject({ type: "message", id: "u1" });
	});

	it("keeps first-match semantics for duplicate entry ids", async () => {
		const file = await writeRoot("1700000000000_dup.jsonl", [
			header(),
			user("dup", null, "first", T + 1000),
			user("dup", null, "second", T + 2000),
		]);
		expect(await getTraceEntry(file, "dup")).toMatchObject({
			message: { content: [{ type: "text", text: "first" }] },
		});
	});
});

function syntheticTrack(id: string, spanCount: number): TraceTrack {
	return {
		id,
		parentId: id === "main" ? null : "main",
		label: id,
		agent: null,
		model: null,
		file: `/tmp/${id}.jsonl`,
		spans: Array.from({ length: spanCount }, (_, index) => ({
			id: `${id}:${index}`,
			kind: "model" as const,
			start: T + index,
			end: T + index + 1,
			label: "m-1",
		})),
		markers: [],
	};
}

describe("trace payload cap", () => {
	it("drops trailing tracks first and then the latest spans", () => {
		const tracks = [syntheticTrack("main", 4), syntheticTrack("a", 4), syntheticTrack("b", 4)];
		const truncated = truncateTraceTracks(tracks, 2, 5);
		expect(tracks).toHaveLength(2);
		expect(tracks[0].spans).toHaveLength(4);
		expect(tracks[1].spans).toHaveLength(1);
		expect(truncated).toEqual({ tracks: 1, spans: 7 });
	});

	it("returns undefined when the payload is within budget", () => {
		const tracks = [syntheticTrack("main", 2), syntheticTrack("a", 2)];
		expect(truncateTraceTracks(tracks, 2, 4)).toBeUndefined();
	});
});
