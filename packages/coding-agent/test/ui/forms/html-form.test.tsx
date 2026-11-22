/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `forms/html-form` corpus: the HTML form dialog driven by keys, UI events
 * and host changes (focus, skip notice, the clock).
 */
import { expect, test, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { nativeShell } from "../../helpers/native-shell";
import { createRoot, signal } from "@oh-my-pi/pi-tui";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import * as prediction from "../../../src/predict/client";
import { parseHtmlForm } from "../../../src/tools/html-form/parse";
import { formMedia, HtmlFormDialog, HtmlFormModel } from "../../../src/ui/forms/html-form";
import { figureWorkSettled } from "../../../src/ui/transcript/figures";
import { keyEvent } from "../../helpers/input-harness";
import { corpusSuite, type Driver, type Mounted, settle } from "../setup/harness";

interface FormInputs {
	readonly html: string;
	readonly title: string | null;
	readonly terminalRows: number;
	readonly focused: boolean;
	readonly timeoutMs: number | null;
	readonly cwd: string;
}

test("native form checkboxes and option-note menus reach the submitted answers", async () => {
	await using ui = await nativeShell();
	const onSubmit = vi.fn();
	const model = new HtmlFormModel(
		parseHtmlForm(`<form>
			<label><input type="checkbox" name="parts" value="arm"> Arm</label>
			<label><input type="checkbox" name="parts" value="leg"> Leg</label>
		</form>`),
		{ onSubmit, onCancel: () => {} },
	);
	ui.shell.dock.slot("ask").set(() => HtmlFormDialog({ model }));
	const list = ui.node("list", "f0");
	const leg = ui.node("item", "o1");
	// Open a note from the second row's own context menu while the first row is highlighted.
	const menu = (leg.p.actions as { menu: string[] }).menu;
	ui.send({ ev: "action", sf: ui.sf, id: leg.id, act: menu[0]! });
	const note = ui.node("editor", "input");
	ui.send({ ev: "edit", sf: ui.sf, id: note.id, from: 0, to: 0, len: 0, text: "repair", cursor: 6 });
	ui.click("button", "save-note");
	ui.send({ ev: "select", sf: ui.sf, id: list.id, item: ui.node("item", "o1").id });
	ui.send({ ev: "activate", sf: ui.sf, id: list.id, item: ui.node("item", "o1").id });
	expect(ui.node("item", "o1").p.icon).toBe("check");
	ui.click("button", "submit");
	expect(onSubmit).toHaveBeenCalledWith({ parts: ["leg"] }, [
		expect.objectContaining({ name: "parts", value: "leg", text: "repair" }),
	]);
});

test("Tab accepts a shown answer completion before leaving the field", async () => {
	const complete = vi.fn(async (_before: string, prefix: string) => (prefix === "cro" ? "ss" : null));
	const backend = vi.spyOn(prediction, "textPredictionBackend").mockReturnValue({ complete, feedback: () => {} });
	const onSubmit = vi.fn();
	const model = new HtmlFormModel(
		parseHtmlForm(`<form><input name="subject"><input type="password" name="secret"></form>`),
		{ onSubmit, onCancel: () => {} },
	);
	const dispose = createRoot(dispose => {
		HtmlFormDialog({ model, autocomplete: "auto" });
		return dispose;
	});
	try {
		for (const ch of "cro") model.key(keyEvent(ch));
		model.ghost({ kind: "text", field: 0 });
		await settle();
		expect(model.ghost({ kind: "text", field: 0 })).toBe("ss");
		expect(model.data().subject).toBe("cro");
		model.key(keyEvent("tab"));
		expect(model.data().subject).toBe("cross ");
		for (const ch of "-platform") model.key(keyEvent(ch));
		model.key(keyEvent("tab"));
		for (const ch of "private") model.key(keyEvent(ch));
		await settle();
		model.key(keyEvent("tab"));
		model.key(keyEvent("enter"));
		expect(onSubmit).toHaveBeenCalledWith({ subject: "cross-platform", secret: "private" }, []);
		expect(complete.mock.calls.some(([, prefix]) => prefix === "privat" || prefix === "private")).toBe(false);
	} finally {
		dispose();
		backend.mockRestore();
	}
});

test("autocorrects prose answers and option notes without sending a structured answer to spelling", async () => {
	const available = vi.spyOn(natives, "macOSSpellCheckerAvailable").mockReturnValue(true);
	const autocorrect = vi.spyOn(natives, "macOSAutocorrectWord").mockImplementation(async (line, start, length) =>
		line.slice(start, start + length) === "recieved" ? "received" : null,
	);
	const onSubmit = vi.fn();
	const model = new HtmlFormModel(
		parseHtmlForm(`<form>
			<input name="subject"><textarea name="details"></textarea>
			<label><input type="checkbox" name="extras" value="ci" checked> CI</label>
			<label><input type="checkbox" name="extras" value="docker"> Docker</label>
			<input type="password" name="private">
		</form>`),
		{ onSubmit, onCancel: () => {} },
	);
	const dispose = createRoot(dispose => {
		HtmlFormDialog({ model, spellingFeatures: { autocorrect: true } });
		return dispose;
	});
	const typeMisspelling = async () => {
		for (const ch of "recieved") model.key(keyEvent(ch));
		model.key(keyEvent("space"));
		await settle();
	};
	try {
		await typeMisspelling();
		model.key(keyEvent("tab"));
		await typeMisspelling();
		model.key(keyEvent("tab"));
		model.startNote();
		await typeMisspelling();
		model.key(keyEvent("enter"));
		model.key(keyEvent("down"));
		model.key(keyEvent("down"));
		await typeMisspelling();
		model.key(keyEvent("tab"));
		await typeMisspelling();
		model.key(keyEvent("tab"));
		model.key(keyEvent("enter"));
		expect(onSubmit).toHaveBeenCalledWith(
			{ subject: "received ", details: "received ", extras: ["ci", "received"], private: "recieved " },
			[expect.objectContaining({ name: "extras", value: "ci", text: "received" })],
		);
		expect(autocorrect).toHaveBeenCalledTimes(4);
	} finally {
		dispose();
		autocorrect.mockRestore();
		available.mockRestore();
	}
});

corpusSuite({
	dir: "forms/html-form",
	mount(caseName, corpusCase, env): Mounted {
		const inputs = corpusCase.inputs as FormInputs;
		const events: string[] = [];
		const form = parseHtmlForm(inputs.html);
		const model = new HtmlFormModel(
			form,
			{
				onSubmit: (data, notes) => void events.push(`submit ${JSON.stringify({ data, notes })}`),
				onCancel: () => void events.push("cancel"),
				onTimeout: (data, notes) => void events.push(`timeout ${JSON.stringify({ data, notes })}`),
				releaseKeys: () => void events.push("releaseKeys"),
				claimKeys: () => void events.push("claimKeys"),
			},
			{ focused: inputs.focused },
		);
		// The capture's terminal cell (pi-tui's default when the terminal does not report one).
		const media = formMedia(form, inputs.cwd, { cell: { w: 9, h: 18 } });
		const skipNotice = signal<string | undefined>(undefined);
		const now = signal(CORPUS_NOW);
		const native = (event: { type: string; key: string; act?: string; item?: string }) => (driver: Driver) => {
			if (event.type === "action") model.action(event.act!, event.key);
			else model.select(Number(/f(\d+)$/.exec(event.key)?.[1] ?? 0), event.item!, event.type === "activate");
			void driver;
		};
		const idle = (ms: number) => async () => {
			env.setNow(CORPUS_NOW + ms);
			now.set(CORPUS_NOW + ms);
			await settle();
		};
		return {
			view: () => (
				<HtmlFormDialog
					model={model}
					title={inputs.title ?? undefined}
					terminalRows={() => inputs.terminalRows}
					media={media}
					skipNotice={skipNotice}
					now={now}
					timeout={inputs.timeoutMs ?? undefined}
				/>
			),
			steps: {
				"native open field 2": native({ type: "action", key: "x", act: "open:2" }),
				"native pick field 1 option 1": native({ type: "action", key: "x", act: "pick:1:1" }),
				"native select body/g0/f0 item o1": native({ type: "select", key: "body/g0/f0", item: "o1" }),
				"native submit": native({ type: "action", key: "actions/submit", act: "submit" }),
				"native note": native({ type: "action", key: "x", act: "note" }),
				"native save-note": native({ type: "action", key: "x", act: "save-note" }),
				"native open field 0": native({ type: "action", key: "x", act: "open:0" }),
				"native cancel": native({ type: "action", key: "x", act: "cancel" }),
				"native select other": native({ type: "select", key: "body/g0/f0", item: "other" }),
				"native pick field 0 option 1": native({ type: "action", key: "x", act: "pick:0:1" }),
				"native open field 1": native({ type: "action", key: "x", act: "open:1" }),
				unfocused: () => model.focused.set(false),
				focused: () => model.focused.set(true),
				"media settled": async () => {
					await figureWorkSettled();
					await settle();
				},
				"skip notice shown": () => skipNotice.set("sending the draft\nskips this form"),
				"skip notice cleared": () => skipNotice.set(undefined),
				"55.5s idle (countdown tick)": idle(55_500),
				"61s idle (timeout fires)": idle(61_000),
			},
			events: () => events.splice(0),
		};
	},
});
