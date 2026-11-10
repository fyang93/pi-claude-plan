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
	extension({ on: (name, handler) => handlers.set(name, handler) } as any);
	const ctx = { hasUI: true, ui: { setWidget() {} } };
	const fire = (name: string) => handlers.get(name)({}, ctx);
	return {
		fire,
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
		assert.equal(app.requests(), 1);
		app.advance(1);
		await app.fire("agent_end");
		assert.equal(app.requests(), 2);
	});
}
