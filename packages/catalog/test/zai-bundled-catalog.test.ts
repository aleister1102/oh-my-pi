import { describe, expect, it } from "bun:test";
import modelsJson from "../src/models.json";

interface BundledModel {
	api: string;
	provider: string;
	baseUrl: string;
	contextWindow: number | null;
	maxTokens: number | null;
	input?: readonly string[];
	reasoning?: boolean;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	thinking?: { efforts?: readonly string[]; defaultLevel?: string; requiresEffort?: boolean };
}

describe("zai bundled catalog", () => {
	it("pins glm-5.2 base entry to 1M context", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.2"];

		expect(model).toBeDefined();
		expect(model.provider).toBe("zai");
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(Object.keys(zaiModels)).not.toContain("glm-5.2[1m]");
	});

	it("bundles glm-5.3-flash with the 1M tier, native image input, and the GLM-5.3 ladder", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.3-flash"];

		expect(model).toBeDefined();
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.reasoning).toBe(true);
		expect(model.thinking?.efforts).toEqual(["low", "high", "max"]);
		expect(model.cost).toEqual({ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
		expect(model.thinking?.requiresEffort).toBe(true);
		expect(model.thinking?.defaultLevel).toBe("max");
	});

	it("bundles the same Flash model for the Zhipu Coding Plan endpoint", () => {
		const zhipuModels = modelsJson["zhipu-coding-plan"] as Record<string, BundledModel>;
		const model = zhipuModels["glm-5.3-flash"];

		expect(model).toBeDefined();
		expect(model.provider).toBe("zhipu-coding-plan");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.reasoning).toBe(true);
		expect(model.cost).toEqual({ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
		expect(model.thinking?.efforts).toEqual(["low", "high", "max"]);
		expect(model.thinking?.requiresEffort).toBe(true);
		expect(model.thinking?.defaultLevel).toBe("max");
	});
});
