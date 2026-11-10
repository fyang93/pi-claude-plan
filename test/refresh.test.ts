import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import extension from "../src/index.ts";

async function setup(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "claude-plan-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	await writeFile(join(dir, "auth.json"), JSON.stringify({ anthropic: { access: "test-token" } }));
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	});
	let now = Date.parse("2026-11-10T00:00:00Z");
	let poll: () => void;
	let answer = () => new Response(JSON.stringify({ five_hour: { utilization: 38 } }));
	t.mock.method(Date, "now", () => now);
	const fetchMock = t.mock.method(globalThis, "fetch", async () => answer());
	t.mock.method(globalThis, "setInterval", (callback: () => void, interval: number) => {
		assert.equal(interval, 300_000);
		poll = callback;
		return { unref() {} };
	});
	t.mock.method(globalThis, "clearInterval", () => {});
	const handlers = new Map();
	const commands = new Map();
	extension({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
	} as any);
	let widget: string[] | undefined;
	const notifications: { message: string; level: string }[] = [];
	const ctx = { hasUI: true, ui: {
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		setWidget: (_key: string, factory: any) => { widget = factory?.().render(160); },
		notify: (message: string, level: string) => notifications.push({ message, level }),
	} };
	const fire = (name: string) => handlers.get(name)({}, ctx);
	return {
		fire,
		ctx,
		widget: () => widget,
		notifications,
		command: (args = "") => commands.get("claude").handler(args, ctx),
		credentials: (raw?: string) => raw === undefined
			? rm(join(dir, "auth.json")) : writeFile(join(dir, "auth.json"), raw),
		start: async () => { await fire("session_start"); await fire("agent_end"); },
		poll: async () => { poll(); await fire("agent_end"); },
		advance: (ms: number) => { now += ms; },
		requests: () => fetchMock.mock.callCount(),
		respond: (callback: () => Response) => { answer = callback; },
	};
}

test("all refresh triggers share a one-minute interval and coalesce requests", async (t) => {
	const app = await setup(t);
	await app.start();
	assert.equal(app.requests(), 1);
	for (let i = 0; i < 10; i++) await app.fire("agent_end");
	app.advance(59_999);
	await app.poll();
	assert.equal(app.requests(), 1);
	app.advance(1);
	await Promise.all([app.fire("agent_end"), app.fire("agent_end")]);
	assert.equal(app.requests(), 2);
	app.advance(300_000);
	await app.poll();
	assert.equal(app.requests(), 3);
	await app.fire("session_shutdown");
});

test("failed requests are throttled too", async (t) => {
	const app = await setup(t);
	app.respond(() => { throw new Error("network unavailable"); });
	await app.start();
	await app.fire("agent_end");
	assert.equal(app.requests(), 1);
	app.advance(60_000);
	await app.fire("agent_end");
	assert.equal(app.requests(), 2);
});

for (const [header, cooldown] of [
	[undefined, 300_000],
	["invalid", 300_000],
	["10", 300_000],
	["600", 600_000],
	["Tue, 10 Nov 2026 00:10:00 GMT", 600_000],
] as const) {
	test(`429 cooldown with Retry-After=${header}`, async (t) => {
		const app = await setup(t);
		app.respond(() => new Response(null, { status: 429, headers: header ? { "Retry-After": header } : {} }));
		await app.start();
		app.advance(cooldown - 1);
		await app.poll();
		await app.command();
		assert.equal(app.requests(), 1);
		assert.match(app.notifications.at(-1)!.message, /cooling down/);
		app.advance(1);
		await app.fire("agent_end");
		assert.equal(app.requests(), 2);
	});
}

for (const raw of [undefined, "{}", "{", '{"anthropic":{"type":"api_key","key":"test-key"}}']) {
	test(`missing OAuth login hides the widget (${raw})`, async (t) => {
		const app = await setup(t);
		await app.credentials(raw);
		await app.start();
		assert.equal(app.requests(), 0);
		assert.equal(app.widget(), undefined);
		await app.command();
		assert.match(app.notifications.at(-1)!.message, /\/login/);
	});
}

test("logout clears cached account data and hides the widget", async (t) => {
	const app = await setup(t);
	await app.start();
	assert.match(app.widget()![0], /38%/);
	await app.credentials("{}");
	app.advance(60_000);
	await app.fire("agent_end");
	assert.equal(app.widget(), undefined);
	assert.equal(app.requests(), 1);
});

for (const status of [401, 403, 429, 500]) {
	test(`HTTP ${status} keeps cached bars with a short error and recovers`, async (t) => {
		const app = await setup(t);
		await app.start();
		app.respond(() => new Response(null, { status }));
		app.advance(60_000);
		await app.fire("agent_end");
		const line = app.widget()![0];
		assert.match(line, /━+ 38%/);
		assert.match(line, status === 401 || status === 403 ? /login expired — \/login/
			: status === 429 ? /rate limited — cooling down/ : /unavailable/);
		assert.doesNotMatch(line, /HTTP|ENOENT/);
		app.respond(() => new Response(JSON.stringify({ five_hour: { utilization: 40 } })));
		app.advance(300_000);
		await app.command();
		assert.match(app.widget()![0], /━+ 40%/);
		assert.doesNotMatch(app.widget()![0], /expired|unavailable|cooling/);
		assert.equal(app.notifications.at(-1)!.message, "Claude limits refreshed.");
	});
}

test("network and JSON failures keep cached bars without exposing raw errors", async (t) => {
	const app = await setup(t);
	await app.start();
	for (const response of [
		() => { throw new Error("sensitive-path-or-token"); },
		() => new Response("not JSON"),
	]) {
		app.respond(response);
		app.advance(60_000);
		await app.fire("agent_end");
		assert.match(app.widget()![0], /Claude │ unavailable │ 5h ━+ 38%/);
		assert.doesNotMatch(app.widget()![0], /sensitive|JSON/);
	}
});

test("manual refresh obeys the interval and rejects reset without a request", async (t) => {
	const app = await setup(t);
	await app.start();
	await app.command();
	assert.equal(app.requests(), 1);
	assert.match(app.notifications.at(-1)!.message, /cached.*60s/);
	app.advance(60_000);
	await app.command("reset");
	assert.equal(app.requests(), 1);
	assert.match(app.notifications.at(-1)!.message, /not supported/);
	await app.command();
	assert.equal(app.requests(), 2);
	assert.equal(app.notifications.at(-1)!.message, "Claude limits refreshed.");
	await app.fire("session_shutdown");
	assert.equal(app.widget(), undefined);
});

test("headless sessions neither poll nor render", async (t) => {
	const app = await setup(t);
	app.ctx.hasUI = false;
	await app.start();
	await app.command();
	assert.equal(app.requests(), 0);
	assert.equal(app.widget(), undefined);
	assert.equal(app.notifications.length, 0);
});
