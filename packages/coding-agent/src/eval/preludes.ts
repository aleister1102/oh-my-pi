import type { AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolApproval } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import {
	approvalRestrictions,
	denyError,
	requestApproval,
	resolveApproval,
	resolveApprovalFromContext,
} from "../tools/approval";

/** Host context supplied when an eval prelude calls back out of its language VM. */
export interface EvalPreludeContext {
	/** Live owning session; authorization is always resolved against its current preludes. */
	session: ToolSession;
	/** Tool-call-shaped identifier assigned to this individual host invocation. */
	toolCallId: string;
	/** Cancellation signal for the active eval cell. */
	signal?: AbortSignal;
	/**
	 * The eval cell's `timeout` in ms, which the cell's watchdog suspends while this call runs; a call that sets
	 * no budget of its own takes this one. 0 when the cell has no timeout; absent when the call comes from no cell.
	 */
	cellTimeoutMs?: number;
	/** Ordinary agent tool context used for settings, UI, and provider metadata. */
	context?: AgentToolContext;
	/** Progress receiver shared with the active eval call. */
	onUpdate?: AgentToolUpdateCallback<unknown>;
}

/**
 * A language prelude whose snippets run in eval VMs while its privileged handler
 * remains in the host process. Prelude definitions are capabilities, not tools:
 * they have no parameter schema, renderer, label, or load mode and never enter a
 * model tool inventory.
 */
export interface EvalPreludeDefinition {
	/** Stable bridge name and registration key. */
	name: string;
	/** Static Markdown documentation shown only while this prelude is enabled. */
	documentation: string;
	/**
	 * One-line listing summary, replacing the first `documentation` line; `""` lists
	 * the global by name alone. MCP eval namespaces set a model-written hint here.
	 */
	summary?: string;
	/**
	 * Render `documentation` in the eval tool description instead of linking it
	 * as an `help://eval/<name>` topic, so the first call needs no `read`.
	 */
	inlineDocumentation?: boolean;
	/**
	 * Short guide the session sends as a hidden message after the tool batch
	 * holding this prelude's first call, so the model can start without reading
	 * the `help://eval/<name>` topic (which keeps `documentation`) while the
	 * always-on tool description keeps one line. Sent again once the context no
	 * longer holds it. Sessions that cannot send it list the prelude as read-first.
	 */
	firstCallDocumentation?: string;
	/** JavaScript source installed into an ordinary JavaScript eval realm. */
	javascript: string;
	/** Python source installed into a Python eval kernel. */
	python: string;
	/** Globals owned by the snippets and removed when the prelude is replaced or disabled. */
	exports: readonly string[];
	/**
	 * Model-facing policy appended as its own system-prompt block while this
	 * prelude is advertised. Replayed by the hidden prelude notice when enabled
	 * mid-session, since the cached system prompt is not rebuilt for the toggle.
	 */
	guidance?: string;
	/** Approval tier or argument-dependent approval decision for host calls. */
	approval?: ToolApproval;
	/**
	 * Fire the session's extension `tool_call` handlers for each host call under this prelude's name, as
	 * for a loop-dispatched tool call, then an observe-only `tool_result` once it settles. Opt in only when
	 * extensions already see this name with the same input shape: a prelude sharing a native tool's name
	 * with a different shape (`computer`) would mislead them. Handler `additionalContext` is ignored.
	 */
	extensionToolCalls?: boolean;
	/** Live availability predicate. Omission means enabled. */
	enabled?: () => boolean;
	/**
	 * Execute a host call outside the language VM. Omitted by preludes whose snippets
	 * only call session tools (`__omp_call_tool__`), which carry their own approval.
	 */
	invoke?(parameters: unknown, context: EvalPreludeContext): Promise<AgentToolResult<unknown>>;
	/**
	 * One-line description of a successful host call for the eval status tree
	 * (`main.goto("https://…")`). `undefined` records nothing; omit the hook
	 * when the call has nothing worth showing. Failures are recorded by the
	 * bridge regardless.
	 */
	status?(parameters: unknown, result: AgentToolResult<unknown>): string | undefined;
}

/** A prelude whose snippets call back into its own host handler through `__omp_prelude__`. */
export interface HostEvalPreludeDefinition extends EvalPreludeDefinition {
	invoke(parameters: unknown, context: EvalPreludeContext): Promise<AgentToolResult<unknown>>;
}

/**
 * Resolve enabled candidates without consulting a session getter (and therefore
 * without recursion). Later definitions replace earlier definitions of the same
 * name, matching extension tool registration precedence.
 */
export function getEnabledEvalPreludes(definitions: readonly EvalPreludeDefinition[]): EvalPreludeDefinition[] {
	const enabledByName = new Map<string, EvalPreludeDefinition>();
	for (const definition of definitions) {
		if (definition.enabled?.() !== false) enabledByName.set(definition.name, definition);
	}
	return Array.from(enabledByName.values());
}

/**
 * The prelude's one-line listing summary: `summary` when set (possibly `""`), else the
 * first documentation line; undefined when undocumented.
 */
export function evalPreludeSummary(
	definition: Pick<EvalPreludeDefinition, "documentation" | "summary">,
): string | undefined {
	if (definition.summary !== undefined) return definition.summary;
	const doc = definition.documentation.trim();
	return doc ? doc.split("\n", 1)[0] : undefined;
}

/** Resolve a prelude from the session's live enabled set. Captured stale VM functions therefore fail closed. */
export function findEnabledEvalPrelude(session: ToolSession, name: string): EvalPreludeDefinition | undefined {
	const definition = session.getEvalPreludes?.().find(candidate => candidate.name === name);
	return definition?.enabled?.() === false ? undefined : definition;
}

/** Strings and comments per cell language: `#` starts a comment only in Python, `//` only in JS. */
const STRINGS_AND_COMMENTS = {
	py: /("""|''')[\s\S]*?\1|(["'])(?:\\.|(?!\2)[^\\])*\2|#.*/g,
	js: /(["'`])(?:\\.|(?!\1)[^\\])*\1|\/\/.*|\/\*[\s\S]*?\*\//g,
} as const;

/**
 * Notes each guide-bearing prelude whose global a cell's code names outside strings, comments, other objects'
 * members and object keys. A first cell often only probes the global (`browser.list?.()`, `Object.keys(browser)`):
 * no host call, so no guide would follow.
 */
export function noteEvalPreludesNamed(code: string, language: "py" | "js", session: ToolSession): void {
	if (!session.noteEvalPreludeCall) return;
	const bare = code.replace(STRINGS_AND_COMMENTS[language], '""');
	for (const definition of getEnabledEvalPreludes(session.getEvalPreludes?.() ?? [])) {
		if (!definition.firstCallDocumentation?.trim()) continue;
		const named =
			new RegExp(`(?<![\\w$./-])(?:globalThis\\s*\\.\\s*)?${definition.name}(?![\\w$/-]|\\s*:)`).test(bare) ||
			new RegExp(`\\{[^{}]*\\b${definition.name}\\s*[:,}=][^{}]*\\}\\s*=\\s*globalThis\\b`).test(bare);
		if (named) session.noteEvalPreludeCall(definition.name);
	}
}

/**
 * Resolve the approval policy for a prelude call against the session's settings. The subject is the
 * prelude name, so a restricted folder matches it by the session's directory.
 */
function resolvePreludePolicy(
	definition: EvalPreludeDefinition,
	parameters: unknown,
	context: EvalPreludeContext,
): { subject: { name: string; approval?: ToolApproval }; resolved: ReturnType<typeof resolveApproval> } {
	// Fourth execute-time site: same helper as wrapper/cursor/mcp so a missing
	// context cannot silently yolo. Empty `context.context` fail-closes;
	// omitting it inherits the live session settings (schema default yolo).
	const settings = context.context?.settings ?? context.session.settings;
	const { approvalMode: mode, userPolicies: policies } = resolveApprovalFromContext(
		context.context ?? (settings ? { settings } : undefined),
	);
	const subject: { name: string; approval?: ToolApproval } = { name: definition.name };
	if (definition.approval !== undefined) subject.approval = definition.approval;
	const resolved = resolveApproval(
		subject,
		parameters,
		mode,
		policies,
		undefined,
		approvalRestrictions(settings, context.session.cwd),
	);
	return { subject, resolved };
}

async function approvePreludeInvocation(
	definition: EvalPreludeDefinition,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<void> {
	context.signal?.throwIfAborted();
	const { subject, resolved } = resolvePreludePolicy(definition, parameters, context);
	if (resolved.policy === "deny") throw denyError(resolved, definition.name);
	if (resolved.policy !== "prompt") return;

	const ui = context.context?.ui;
	if (!ui || context.context?.hasUI === false) {
		throw new Error(
			`Eval prelude "${definition.name}" requires approval but no interactive UI is available.\n` +
				`Set tools.approval.${definition.name}: allow or use an interactive UI to approve the call.`,
		);
	}
	const answer = await untilAborted(context.signal, () =>
		requestApproval(ui, subject, parameters, { reason: resolved.reason, signal: context.signal }),
	);
	if (answer === "deny") throw new Error(`Eval prelude call denied by user: ${definition.name}`);
}

/**
 * Runs the extension `tool_call` handlers for a prelude call that opted in with `extensionToolCalls`,
 * so an extension that blocks or revises e.g. `browser` calls also sees the ones made from eval.
 * A call its approval policy already denies never reaches extensions, matching the loop; the approval
 * gate that follows throws the denial. Otherwise the gate resolves against the input that executes.
 * `announced` is set once handlers saw the call: every outcome from then on, a later handler's block
 * included, follows as a `tool_result` so a handler that set something up for the call can release it.
 */
async function applyToolCallHooks(
	definition: EvalPreludeDefinition,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<{ parameters: unknown; announced: boolean; blockReason?: string }> {
	const emit = context.session.emitToolCall;
	const unchanged = { parameters, announced: false };
	if (definition.extensionToolCalls !== true || !emit) return unchanged;
	if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) return unchanged;
	if (resolvePreludePolicy(definition, parameters, context).resolved.policy === "deny") return unchanged;
	const result = await emit.call(
		context.session,
		{
			type: "tool_call",
			toolName: definition.name,
			toolCallId: context.toolCallId,
			input: parameters as Record<string, unknown>,
		},
		context.signal,
	);
	if (result?.block) {
		return {
			parameters,
			announced: true,
			blockReason: result.reason || `Eval prelude call blocked by an extension: ${definition.name}`,
		};
	}
	return { parameters: result?.input ?? parameters, announced: true };
}

/** Reports an announced prelude call's outcome to `tool_result` handlers; their failures never mask it. */
async function emitPreludeResult(
	definition: EvalPreludeDefinition,
	parameters: unknown,
	context: EvalPreludeContext,
	outcome: { result: AgentToolResult<unknown> } | { error: unknown },
): Promise<void> {
	const emit = context.session.emitToolResult;
	if (!emit) return;
	const failed = "error" in outcome;
	await emit
		.call(context.session, {
			type: "tool_result",
			toolName: definition.name,
			toolCallId: context.toolCallId,
			input: parameters as Record<string, unknown>,
			content: failed
				? [{ type: "text", text: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }]
				: outcome.result.content,
			details: failed ? undefined : outcome.result.details,
			isError: failed,
		})
		.catch(() => undefined);
}

/**
 * Invoke a prelude through the live session registry. Authorization is resolved
 * before the handler runs and repeated when an awaited approval raced with a
 * replacement, so a disabled or replaced captured function cannot retain host
 * access under stale policy.
 */
export async function invokeEvalPrelude(
	name: string,
	rawParameters: unknown,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	context.signal?.throwIfAborted();
	const definition = findEnabledEvalPrelude(context.session, name);
	if (!definition) throw new Error(`Eval prelude "${name}" is not enabled in the current session.`);
	if (!definition.invoke) throw new Error(`Eval prelude "${name}" has no host calls.`);

	const hooked = await applyToolCallHooks(definition, rawParameters, context);
	const { parameters } = hooked;
	if (!hooked.announced) return authorizeAndInvoke(name, definition, parameters, context);
	let result: AgentToolResult<unknown>;
	try {
		if (hooked.blockReason !== undefined) throw new Error(hooked.blockReason);
		result = await authorizeAndInvoke(name, definition, parameters, context);
	} catch (error) {
		await emitPreludeResult(definition, parameters, context, { error });
		throw error;
	}
	await emitPreludeResult(definition, parameters, context, { result });
	return result;
}

async function authorizeAndInvoke(
	name: string,
	initial: EvalPreludeDefinition,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	let definition = initial;
	await approvePreludeInvocation(definition, parameters, context);
	context.signal?.throwIfAborted();
	const current = findEnabledEvalPrelude(context.session, name);
	if (!current) throw new Error(`Eval prelude "${name}" is not enabled in the current session.`);
	if (current !== definition) {
		definition = current;
		await approvePreludeInvocation(definition, parameters, context);
		context.signal?.throwIfAborted();
		if (findEnabledEvalPrelude(context.session, name) !== definition) {
			throw new Error(`Eval prelude "${name}" changed while authorizing the call.`);
		}
	}
	if (!definition.invoke) throw new Error(`Eval prelude "${name}" has no host calls.`);
	// Even a call that fails shows the model has reached for this prelude, so its guide is due.
	if (definition.firstCallDocumentation?.trim()) context.session.noteEvalPreludeCall?.(definition.name);
	return definition.invoke(parameters, context);
}
