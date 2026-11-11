import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderQuota, type QuotaView, type Paint, type UsageResponse } from "./quota.ts";
import { accountKey, agentDir, sharedRefresh, type Fetched } from "./shared.ts";

const BASE = "https://api.anthropic.com";
const KEY = "claude-plan";
const REFRESH_MS = 5 * 60_000;
const MIN_REQUEST_INTERVAL_MS = 60_000;
// The periodic poll only fetches when no session has refreshed within (almost) a full period.
const TIMER_MIN_AGE_MS = REFRESH_MS - 5_000;

async function token(): Promise<string | undefined> {
	try {
		const auth = JSON.parse(await readFile(join(agentDir(), "auth.json"), "utf8"))?.anthropic;
		return typeof auth?.access === "string" && auth.access.trim() ? auth.access : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
		throw error;
	}
}

export default function (pi: ExtensionAPI) {
	let view: QuotaView = {};
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing: Promise<boolean> | undefined;
	let hasLogin = false;
	// Shared by every pi session, so many open sessions cost no more requests than one.
	const shared = sharedRefresh<QuotaView>("claude-plan-usage");

	const paint = (ctx: ExtensionContext): Paint => ({
		fg: (color, text) => ctx.ui.theme.fg(color, text),
		bold: (text) => ctx.ui.theme.bold(text),
	});
	const render = (ctx: ExtensionContext) => ctx.ui.setWidget(KEY, () => ({
		render: (width: number) => renderQuota(view, width, paint(ctx)),
		invalidate: () => {},
	}), { placement: "belowEditor" });

	// Failed attempts count as attempts, so errors cannot trigger a request after every turn.
	const fetchUsage = async (access: string, previous: QuotaView = {}): Promise<Fetched<QuotaView>> => {
		try {
			const response = await fetch(`${BASE}/api/oauth/usage`, {
				headers: { Authorization: `Bearer ${access}`, "anthropic-beta": "oauth-2025-04-20" },
				signal: AbortSignal.timeout(20_000),
			});
			if (response.status === 401 || response.status === 403) {
				return { view: { ...previous, error: "login expired — /login" } };
			}
			if (response.status === 429) {
				const retryAfter = response.headers.get("Retry-After");
				const retryAt = retryAfter === null ? Number.NaN
					: /^\d+(\.\d+)?$/.test(retryAfter.trim())
						? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
				return {
					view: { ...previous, error: "rate limited — cooling down" },
					retryAt: Math.max(Date.now() + REFRESH_MS, Number.isFinite(retryAt) ? retryAt : 0),
				};
			}
			if (!response.ok) return { view: { ...previous, error: "unavailable" } };
			return { view: { usage: await response.json() as UsageResponse } };
		} catch {
			return { view: { ...previous, error: "unavailable" } };
		}
	};

	/** Resolves to whether this call sent a request, rather than reusing the shared snapshot. */
	const refresh = (ctx: ExtensionContext, minAge = MIN_REQUEST_INTERVAL_MS): Promise<boolean> => {
		refreshing ??= (async () => {
			try {
				const access = await token();
				hasLogin = Boolean(access);
				if (!access) {
					view = {};
					shared.forget();
					ctx.ui.setWidget(KEY, undefined);
					return false;
				}
				const result = await shared.refresh(accountKey(access), minAge, previous => fetchUsage(access, previous));
				view = result.view ?? {};
				render(ctx);
				return result.fetched;
			} catch {
				view = { ...view, error: "unavailable" };
				render(ctx);
				return false;
			} finally {
				refreshing = undefined;
			}
		})();
		return refreshing;
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		void refresh(ctx);
		if (timer) clearInterval(timer);
		timer = setInterval(() => void refresh(ctx, TIMER_MIN_AGE_MS), REFRESH_MS);
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
			const fetched = await refresh(ctx);
			if (!hasLogin && !view.error) {
				ctx.ui.notify("pi is not logged in to Anthropic. Run /login and pick Anthropic.", "error");
			} else if (view.error) {
				ctx.ui.notify(view.error, "error");
			} else if (!fetched) {
				const wait = Math.max(0, Math.ceil((shared.nextAt(MIN_REQUEST_INTERVAL_MS) - Date.now()) / 1000));
				ctx.ui.notify(`Claude usage cached; next refresh allowed in ${wait}s.`, "info");
			} else {
				ctx.ui.notify("Claude limits refreshed.", "info");
			}
		},
	});
}
