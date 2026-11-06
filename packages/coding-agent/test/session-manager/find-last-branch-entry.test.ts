import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("SessionManager.findLastBranchEntry", () => {
	it("returns the newest metadata-matching entry on the active branch", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("digest", "first");
		manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		const newestId = manager.appendCustomEntry("digest", "second");
		manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");

		const found = manager.findLastBranchEntry(
			metadata => metadata.type === "custom" && metadata.customType === "digest",
		);
		expect(found?.id).toBe(newestId);
	});

	it("skips candidates the payload check rejects and ignores abandoned branches", () => {
		const manager = SessionManager.inMemory();
		const keptId = manager.appendCustomEntry("digest", "kept");
		const forkPoint = manager.appendCustomEntry("digest", "malformed-on-purpose");
		manager.appendCustomEntry("digest", "abandoned");
		manager.branch(forkPoint);

		const found = manager.findLastBranchEntry(
			metadata => metadata.customType === "digest",
			entry => entry.type === "custom" && entry.data === "kept",
		);
		expect(found?.id).toBe(keptId);

		const newest = manager.findLastBranchEntry(metadata => metadata.customType === "digest");
		expect(newest?.id).toBe(forkPoint);
	});

	it("returns undefined when nothing matches", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		expect(manager.findLastBranchEntry(metadata => metadata.type === "compaction")).toBeUndefined();
	});

	it("stops before stopAtId without visiting older entries", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("digest", "old");
		const stopId = manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		const newerId = manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");
		const visited: string[] = [];
		const found = manager.findLastBranchEntry(
			metadata => {
				visited.push(metadata.id);
				return metadata.customType === "digest";
			},
			undefined,
			stopId,
		);
		expect(found).toBeUndefined();
		expect(visited).toEqual([newerId]);
	});
});

describe("SessionManager.getBranchRevision", () => {
	it("keeps its value across appends to the leaf and advances when the branch is replaced", () => {
		const manager = SessionManager.inMemory();
		const forkPoint = manager.appendCustomEntry("digest", "first");
		manager.appendCustomEntry("digest", "second");
		const revision = manager.getBranchRevision();
		manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		expect(manager.getBranchRevision()).toBe(revision);
		manager.branch(forkPoint);
		expect(manager.getBranchRevision()).not.toBe(revision);
	});
});
