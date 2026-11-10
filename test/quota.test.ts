import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { renderQuota, formatDuration, type Paint, type UsageResponse } from "../src/quota.ts";

const plain: Paint = { fg: (_color, text) => text, bold: text => text };
const tagged: Paint = { fg: (color, text) => `<${color}>${text}`, bold: text => `*${text}*` };
const ansi: Paint = { fg: (_color, text) => `\x1b[38;2;120;100;80m${text}\x1b[39m`, bold: text => `\x1b[1m${text}\x1b[22m` };
const NOW = Date.parse("2026-11-10T00:00:00Z");
const weeklyReset = new Date(NOW + 3 * 86_400_000 + 4 * 3_600_000).toISOString();
const usage: UsageResponse = {
	five_hour: { utilization: 12, resets_at: new Date(NOW + 150 * 60_000).toISOString() },
	seven_day: { utilization: 59, resets_at: weeklyReset },
	limits: [{ kind: "weekly_scoped", percent: 88, resets_at: weeklyReset, scope: { model: { display_name: "Fable" } } }],
};

test("wide lines show Claude, three windows, reset times, used percentages and adaptive bars", () => {
	const [line, divider] = renderQuota({ usage }, 120, plain, NOW);
	assert.match(line, /^Claude │ 5h 2h30m ━+ 12% │ All 3d4h ━+ 59% │ Fable 3d4h ━+ 88%$/);
	assert.equal(divider, "─".repeat(120));
	assert.ok(line.length <= 120);
	assert.ok(line.length >= 118);
	assert.equal(formatDuration(-60_000), "0m");
	assert.equal(formatDuration(150 * 60_000), "2h30m");
});

test("title separators are dim; bars use remaining-quota warning colors", () => {
	const [line] = renderQuota({ usage }, 68, tagged, NOW);
	assert.match(line, /^\*<text>Claude\*<dim> │ /);
	assert.match(line, /\*<muted>5h\*/);
	assert.match(line, /\*<warning>All\*/);
	assert.match(line, /\*<error>Fable\*/);
	assert.match(line, /<warning>━━<dim>━━/);
	assert.match(line, /<error>━━━━<dim> /);
});

test("warning thresholds match Codex at 50% and 75% used", () => {
	for (const [used, color] of [[50, "muted"], [51, "warning"], [75, "warning"], [76, "error"]] as const) {
		const [line] = renderQuota({ usage: { five_hour: { utilization: used } } }, 80, tagged, NOW);
		assert.match(line, new RegExp(`\\*<${color}>5h\\*`));
	}
});

test("ANSI styling never changes bar allocation or causes terminal overflow", () => {
	for (const view of [{ usage }, { usage, error: "login expired — /login" }, { error: "unavailable" }, {}]) {
		for (let width = 0; width <= 160; width++) {
			const expected = renderQuota(view, width, plain, NOW);
			const actual = renderQuota(view, width, ansi, NOW).map(stripVTControlCharacters);
			assert.deepEqual(actual, expected);
			for (const line of actual) assert.ok([...line].length <= width, `width ${width}: ${line}`);
		}
	}
});

test("narrow screens drop title, bars, times, then 5h and Fable, keeping All last", () => {
	const at = (width: number) => renderQuota({ usage }, width, plain, NOW)[0];
	assert.match(at(68), /^Claude │ 5h 2h30m ━{4} 12%/);
	assert.match(at(59), /^5h 2h30m ━{4} 12%/);
	assert.equal(at(58), "5h 2h30m 12% │ All 3d4h 59% │ Fable 3d4h 88%");
	assert.equal(at(30), "5h 12% │ All 59% │ Fable 88%");
	assert.equal(at(20), "All 59% │ Fable 88%");
	assert.equal(at(7), "All 59%");
	assert.equal(at(6), "");
});

test("errors appear next to cached bars, and long errors compact safely", () => {
	const [line] = renderQuota({ usage, error: "unavailable" }, 120, plain, NOW);
	assert.match(line, /^Claude │ unavailable │ 5h .*━/);
	assert.match(line, /All .*59% │ Fable .*88%/);
	assert.equal(renderQuota({ error: "login expired — /login" }, 80, plain, NOW)[0], "Claude │ login expired — /login");
	assert.equal(renderQuota({ error: "login expired — /login" }, 12, plain, NOW)[0], "login expir…");
});

test("legacy Fable windows still work, scoped zero percent wins and absent windows stay hidden", () => {
	for (const key of ["seven_day_fable", "fable_seven_day"] as const) {
		assert.match(renderQuota({ usage: { [key]: { utilization: 8 } } }, 80, plain, NOW)[0], /Fable ━+ 8%/);
	}
	assert.match(renderQuota({ usage: {
		seven_day_fable: { utilization: 88 },
		limits: [{ kind: "weekly_scoped", percent: 0, scope: { model: { display_name: " FABLE " } } }],
	} }, 80, plain, NOW)[0], /Fable ━+ 0%/);
	assert.doesNotMatch(renderQuota({ usage: { five_hour: usage.five_hour } }, 80, plain, NOW)[0], /All|Fable/);
});

test("invalid values are omitted, percentages are clamped, expired resets stay at zero", () => {
	const [line] = renderQuota({ usage: {
		five_hour: { utilization: -1, resets_at: new Date(NOW - 1).toISOString() },
		seven_day: { utilization: 120, resets_at: "invalid" },
		seven_day_fable: { utilization: NaN },
	} }, 120, plain, NOW);
	assert.match(line, /5h 0m ━+ 0% │ All ━+ 100%/);
	assert.doesNotMatch(line, /NaN|Fable/);
});
