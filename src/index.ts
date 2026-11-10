import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderQuota, type QuotaView, type Paint, type UsageResponse } from "./quota.ts";

const BASE = "https://api.anthropic.com";
const KEY = "claude-plan";
const REFRESH_MS = 5 * 60_000;
const MIN_REQUEST_INTERVAL_MS = 60_000;

async function token(): Promise<string | undefined> {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	try {
		const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"))?.anthropic;
		return typeof auth?.access === "string" && auth.access.trim() ? auth.access : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
		throw error;
	}
}

export default function (pi: ExtensionAPI) {
	let view: QuotaView = {};
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing: Promise<void> | undefined;
	let nextRequestAt = 0;
	let hasLogin = false;

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
				hasLogin = Boolean(access);
				if (!access) {
					view = {};
					ctx.ui.setWidget(KEY, undefined);
					return;
				}
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
				if (response.status === 401 || response.status === 403) {
					view = { ...view, error: "login expired — /login" };
				} else if (response.status === 429) {
					view = { ...view, error: "rate limited — cooling down" };
				} else if (!response.ok) {
					view = { ...view, error: "unavailable" };
				} else {
					view = { usage: await response.json() as UsageResponse };
				}
			} catch {
				view = { ...view, error: "unavailable" };
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

	pi.registerCommand("claude", {
		description: "Refresh Claude plan usage (subject to the request cooldown)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (args.trim()) {
				ctx.ui.notify("Usage: /claude — refresh usage. Reset redemption is not supported by this extension.", "warning");
				return;
			}
			const throttled = !refreshing && Date.now() < nextRequestAt;
			await refresh(ctx);
			if (!hasLogin && !view.error) {
				ctx.ui.notify("pi is not logged in to Anthropic. Run /login and pick Anthropic.", "error");
			} else if (view.error) {
				ctx.ui.notify(view.error, "error");
			} else if (throttled) {
				ctx.ui.notify(`Claude usage cached; next refresh allowed in ${Math.ceil((nextRequestAt - Date.now()) / 1000)}s.`, "info");
			} else {
				ctx.ui.notify("Claude limits refreshed.", "info");
			}
		},
	});
}
