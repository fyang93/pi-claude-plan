import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderQuota, type QuotaView, type Paint, type UsageResponse } from "./quota.ts";

const BASE = "https://api.anthropic.com";
const KEY = "claude-plan";
const REFRESH_MS = 5 * 60_000;
const MIN_REQUEST_INTERVAL_MS = 60_000;

async function token(): Promise<string> {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"))?.anthropic;
	if (!auth?.access) throw new Error("pi is not logged in to Anthropic. Run /login and pick Anthropic.");
	return auth.access;
}

export default function (pi: ExtensionAPI) {
	let view: QuotaView = {};
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing: Promise<void> | undefined;
	let nextRequestAt = 0;

	const paint = (ctx: ExtensionContext): Paint => ({
		fg: (color, text) => ctx.ui.theme.fg(color, text),
		bold: (text) => ctx.ui.theme.bold(text),
	});
	const render = (ctx: ExtensionContext) => ctx.ui.setWidget(KEY, () => ({
		render: (width: number) => renderQuota(view, width, paint(ctx)),
		invalidate: () => {},
	}), { placement: "belowEditor" });

	const refresh = (ctx: ExtensionContext): Promise<void> | undefined => {
		if (refreshing) return refreshing;
		if (Date.now() < nextRequestAt) return;
		// Count failed attempts too, so errors cannot trigger a request after every turn.
		nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
		refreshing = (async () => {
			try {
				const access = await token();
				const response = await fetch(`${BASE}/api/oauth/usage`, {
					headers: { Authorization: `Bearer ${access}`, "anthropic-beta": "oauth-2025-04-20" },
					signal: AbortSignal.timeout(20_000),
				});
				if (response.status === 429) {
					const retryAfter = response.headers.get("Retry-After");
					const retryAt = retryAfter === null ? Number.NaN
						: /^\d+(\.\d+)?$/.test(retryAfter.trim())
							? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
					nextRequestAt = Math.max(Date.now() + REFRESH_MS, Number.isFinite(retryAt) ? retryAt : 0);
				}
				if (!response.ok) throw new Error(`Claude usage failed: HTTP ${response.status}`);
				view = { usage: await response.json() as UsageResponse };
			} catch (error) {
				view = { ...view, error: error instanceof Error ? error.message : String(error) };
			} finally {
				refreshing = undefined;
			}
			render(ctx);
		})();
		return refreshing;
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		void refresh(ctx);
		if (timer) clearInterval(timer);
		timer = setInterval(() => void refresh(ctx), REFRESH_MS);
		timer.unref?.();
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI) await refresh(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		ctx.ui.setWidget(KEY, undefined);
	});
}
