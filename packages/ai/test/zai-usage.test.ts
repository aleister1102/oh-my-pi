import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { zaiRankingStrategy, zaiUsageProvider } from "@oh-my-pi/pi-ai/usage/zai";

function makeCredential(): UsageFetchParams["credential"] {
	return {
		type: "api_key",
		apiKey: "zai-test-key",
	};
}

function makeCtx(payload: unknown): UsageFetchContext {
	const fetch: FetchImpl = async input => {
		const url = String(input);
		if (url.includes("/api/monitor/usage/model-usage")) {
			return new Response(JSON.stringify({ success: true, data: {} }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch };
}

function makeOAuthCredential(): UsageFetchParams["credential"] {
	return {
		type: "oauth",
		accessToken: "minted-id.minted-secret",
		accountId: "acc-1",
		email: "user@example.com",
	};
}

function makeRecordingCtx(payload: unknown, sink: { authorization?: string }): UsageFetchContext {
	const fetch: FetchImpl = async (input, init) => {
		const url = String(input);
		sink.authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
		if (url.includes("/api/monitor/usage/model-usage")) {
			return new Response(JSON.stringify({ success: true, data: {} }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch };
}

describe("zai usage provider", () => {
	it("preserves Z.AI token quota windows instead of treating them as separate accounts", async () => {
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{
							type: "TIME_LIMIT",
							usage: 100,
							currentValue: 0,
							percentage: 0,
							remaining: 100,
							nextResetTime: 1784547608994,
							unit: 5,
							number: 1,
							usageDetails: [
								{ modelCode: "search-prime", usage: 0 },
								{ modelCode: "web-reader", usage: 0 },
								{ modelCode: "zread", usage: 0 },
							],
						},
						{ type: "TOKENS_LIMIT", percentage: 82, nextResetTime: 1782656863894, unit: 3, number: 5 },
						{ type: "TOKENS_LIMIT", percentage: 38, nextResetTime: 1783165208993, unit: 6, number: 7 },
					],
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual([
			"zai:features:zread:1mo",
			"zai:tokens:5h",
			"zai:tokens:1w",
		]);
		expect(report!.limits.map(limit => limit.label)).toEqual([
			"ZAI Zread Quota",
			"ZAI 5 Hours Token Quota",
			"ZAI Weekly Token Quota",
		]);
		expect(report!.limits.map(limit => limit.scope.windowId)).toEqual(["1mo", "5h", "1w"]);
		expect(report!.limits.map(limit => limit.scope.shared)).toEqual([false, true, true]);
		expect(report!.limits[0]?.scope.tier).toBe("zread");
		expect(report!.limits.map(limit => limit.window?.durationMs)).toEqual([
			30 * 24 * 60 * 60 * 1000,
			5 * 60 * 60 * 1000,
			7 * 24 * 60 * 60 * 1000,
		]);
	});

	it("reports current Z.AI credit-plan quota rows", async () => {
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{
							type: "CREDIT_LIMIT",
							usage: 2000,
							currentValue: 2000,
							percentage: 100,
							remaining: 0,
							nextResetTime: 1787816962823,
							unit: 3,
							number: 5,
						},
						{
							type: "CREDIT_LIMIT",
							usage: 10000,
							currentValue: 4200,
							percentage: 42,
							remaining: 5800,
							nextResetTime: 1787934509983,
							unit: 6,
							number: 7,
						},
					],
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual(["zai:credits:5h", "zai:credits:1w"]);
		expect(report!.limits.map(limit => limit.label)).toEqual(["ZAI 5 Hours Credit Quota", "ZAI Weekly Credit Quota"]);
		expect(report!.limits.map(limit => limit.amount.unit)).toEqual(["credits", "credits"]);
		expect(report!.limits.map(limit => limit.amount.used)).toEqual([2000, 4200]);
		expect(report!.limits.map(limit => limit.amount.limit)).toEqual([2000, 10000]);

		const windows = zaiRankingStrategy.findWindowLimits(report!);
		expect(windows.primary?.id).toBe("zai:credits:5h");
		expect(windows.secondary?.id).toBe("zai:credits:1w");
	});

	it("supports both api-key and oauth credentials, rejecting oauth rows with no access token", () => {
		expect(zaiUsageProvider.supports!({ provider: "zai", credential: makeCredential(), signal: undefined })).toBe(
			true,
		);
		expect(
			zaiUsageProvider.supports!({ provider: "zai", credential: makeOAuthCredential(), signal: undefined }),
		).toBe(true);
		expect(zaiUsageProvider.supports!({ provider: "zai", credential: { type: "oauth" }, signal: undefined })).toBe(
			false,
		);
	});

	it("fetches quota for an oauth sign-in credential using the minted key as the auth header", async () => {
		const sink: { authorization?: string } = {};
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeOAuthCredential(), signal: undefined },
			makeRecordingCtx(
				{
					success: true,
					data: {
						limits: [{ type: "TOKENS_LIMIT", percentage: 82, nextResetTime: 1782656863894, unit: 3, number: 5 }],
					},
				},
				sink,
			),
		);

		expect(report).not.toBeNull();
		expect(report!.limits[0]?.id).toBe("zai:tokens:5h");
		expect(report!.metadata?.accountId).toBe("acc-1");
		// Minted id.secret key sent verbatim (no Bearer prefix), same as the paste path.
		expect(sink.authorization).toBe("minted-id.minted-secret");
	});
});
