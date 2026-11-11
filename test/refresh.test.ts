import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
	let answer: () => Response | Promise<Response> = () => new Response(JSON.stringify({ five_hour: { utilization: 38 } }));
	t.mock.method(Date, "now", () => now);
	const fetchMock = t.mock.method(globalThis, "fetch", async () => answer());
	t.mock.method(globalThis, "setInterval", (callback: () => void, interval: number) => {
		assert.equal(interval, 300_000);
		poll = callback;
		return { unref() {} };
	});
	t.mock.method(globalThis, "clearInterval", () => {});
	// Each call is one pi session; all of them share the agent directory, the clock and the backend.
	const session = () => {
		const handlers = new Map();
		const commands = new Map();
		extension({
			on: (name, handler) => handlers.set(name, handler),
			registerCommand: (name, command) => commands.set(name, command),
		} as any);
		let widget: string[] | undefined;
		let tick: () => void;
		const notifications: { message: string; level: string }[] = [];
		const ctx = { hasUI: true, ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setWidget: (_key: string, factory: any) => { widget = factory?.().render(160); },
			notify: (message: string, level: string) => notifications.push({ message, level }),
		} };
		const fire = (name: string) => {
			const done = handlers.get(name)({}, ctx);
			// The interval is registered synchronously, before another session can replace `poll`.
			if (name === "session_start") tick = poll;
			return done;
		};
		return {
			fire,
			ctx,
			widget: () => widget,
			notifications,
			command: (args = "") => commands.get("claude").handler(args, ctx),
			start: async () => { await fire("session_start"); await fire("agent_end"); },
			poll: async () => { tick(); await fire("agent_end"); },
			// The periodic poll alone, without the after-turn refresh that `poll` adds.
			tick: async () => { tick(); await new Promise(resolve => setTimeout(resolve, 20)); },
		};
	};
	return {
		...session(),
		session,
		dir,
		credentials: (raw?: string) => raw === undefined
			? rm(join(dir, "auth.json")) : writeFile(join(dir, "auth.json"), raw),
		advance: (ms: number) => { now += ms; },
		now: () => now,
		requests: () => fetchMock.mock.callCount(),
		respond: (callback: () => Response | Promise<Response>) => { answer = callback; },
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

test("sessions share one snapshot instead of each querying the backend", async (t) => {
	const app = await setup(t);
	const other = app.session();
	let release!: () => void;
	app.respond(() => new Promise(resolve => {
		release = () => resolve(new Response(JSON.stringify({ five_hour: { utilization: 38 } })));
	}));
	// Both sessions start at once: the second waits for the first one's result.
	const starting = [app.start(), other.start()];
	await new Promise(resolve => setTimeout(resolve, 50));
	release();
	await Promise.all(starting);
	assert.equal(app.requests(), 1);
	assert.match(app.widget()![0], /38%/);
	assert.match(other.widget()![0], /38%/);

	// A turn in one session refreshes the snapshot; the others pick it up on their next poll
	// without a request, because it is less than a full period old.
	app.respond(() => new Response(JSON.stringify({ five_hour: { utilization: 40 } })));
	app.advance(120_000);
	await other.fire("agent_end");
	assert.equal(app.requests(), 2);
	assert.match(app.widget()![0], /38%/);
	app.advance(180_000);
	await app.tick();
	assert.equal(app.requests(), 2);
	assert.match(app.widget()![0], /40%/);
	app.advance(120_000);
	await app.tick();
	assert.equal(app.requests(), 3);
});

test("a 429 cooldown applies to every session", async (t) => {
	const app = await setup(t);
	await app.start();
	app.respond(() => new Response(null, { status: 429, headers: { "Retry-After": "600" } }));
	app.advance(60_000);
	await app.fire("agent_end");
	const other = app.session();
	await other.start();
	app.advance(599_999);
	await other.poll();
	await other.command();
	assert.equal(app.requests(), 2);
	assert.match(other.widget()![0], /rate limited — cooling down │ 5h ━+ 38%/);
	assert.match(other.notifications.at(-1)!.message, /cooling down/);
});

test("a lock left by a crashed session is taken over; a snapshot of another account is ignored", async (t) => {
	const app = await setup(t);
	await writeFile(join(app.dir, "claude-plan-usage.lock"), String(app.now() - 30_000));
	await app.start();
	assert.equal(app.requests(), 1);
	assert.match(app.widget()![0], /38%/);
	assert.deepEqual((await readdir(app.dir)).sort(), ["auth.json", "claude-plan-usage.json"]);
	assert.doesNotMatch(await readFile(join(app.dir, "claude-plan-usage.json"), "utf8"), /test-token/);

	await app.credentials(JSON.stringify({ anthropic: { access: "other-account" } }));
	app.respond(() => new Response(JSON.stringify({ five_hour: { utilization: 7 } })));
	const other = app.session();
	await other.start();
	assert.equal(app.requests(), 2);
	assert.match(other.widget()![0], / 7%/);
});
