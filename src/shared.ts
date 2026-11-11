/**
 * Cross-session refresh coordination: every pi session reads and writes one snapshot file in the
 * agent directory, and a lock file makes sure only one of them talks to the backend at a time.
 */

import { createHash } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Longer than any request timeout, so a live fetch is never mistaken for a crashed one. */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 250;
const LOCK_POLLS = 100;

export const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

/** Identifies the logged-in account without storing the credential itself. */
export const accountKey = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 16);

export interface Snapshot<V> {
	key: string;
	/** When the last attempt started, successful or not. */
	fetchedAt: number;
	/** Backend-imposed cooldown; no request before this time. */
	retryAt: number;
	view: V;
}

export interface Fetched<V> { view: V; retryAt?: number }

export function sharedRefresh<V>(name: string) {
	const file = () => join(agentDir(), `${name}.json`);
	const lockFile = () => join(agentDir(), `${name}.lock`);
	// Kept in memory as well, so throttling still works if the directory is not writable.
	let state: Snapshot<V> | undefined;

	const read = async (key: string): Promise<Snapshot<V> | undefined> => {
		try {
			const snapshot = JSON.parse(await readFile(file(), "utf8"));
			return snapshot?.key === key && typeof snapshot.fetchedAt === "number"
				&& typeof snapshot.retryAt === "number" && snapshot.view && typeof snapshot.view === "object"
				? snapshot : undefined;
		} catch {
			return;
		}
	};

	const write = async (snapshot: Snapshot<V>) => {
		const tmp = `${file()}.${process.pid}.tmp`;
		try {
			await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
			await rename(tmp, file());
		} catch {
			await rm(tmp, { force: true }).catch(() => {});
		}
	};

	const lock = async (): Promise<boolean> => {
		for (const lastTry of [false, true]) {
			try {
				await writeFile(lockFile(), String(Date.now()), { flag: "wx" });
				return true;
			} catch (error) {
				// Without a usable lock file, fall back to per-session throttling.
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return true;
			}
			if (lastTry) break;
			try {
				const lockedAt = Number(await readFile(lockFile(), "utf8")) || (await stat(lockFile())).mtimeMs;
				if (Date.now() - lockedAt < LOCK_STALE_MS) break;
				await rm(lockFile(), { force: true });
			} catch {
				// The holder just released it; try once more.
			}
		}
		return false;
	};

	return {
		/**
		 * Returns the newest view for this account. Fetches only if no session has tried within
		 * `minAge` and no cooldown is active; otherwise the shared snapshot is reused.
		 */
		async refresh(key: string, minAge: number, fetcher: (previous?: V) => Promise<Fetched<V>>): Promise<{ view?: V; fetched: boolean }> {
			if (state?.key !== key) state = undefined;
			const fresh = async () => {
				const shared = await read(key);
				if (shared && shared.fetchedAt >= (state?.fetchedAt ?? 0)) state = shared;
				return Boolean(state) && (Date.now() < state!.retryAt || Date.now() - state!.fetchedAt < minAge);
			};
			// While another session is fetching, wait for its snapshot instead of sending a second request.
			let locked = false;
			for (let i = 0; i < LOCK_POLLS && !(await fresh()) && !(locked = await lock()); i++) await sleep(LOCK_POLL_MS);
			if (!locked) return { view: state?.view, fetched: false };
			try {
				if (await fresh()) return { view: state?.view, fetched: false };
				const fetchedAt = Date.now();
				const result = await fetcher(state?.view);
				state = { key, fetchedAt, retryAt: result.retryAt ?? 0, view: result.view };
				await write(state);
				return { view: state.view, fetched: true };
			} finally {
				await rm(lockFile(), { force: true }).catch(() => {});
			}
		},
		/** Earliest time a request with the given `minAge` would be sent. */
		nextAt: (minAge: number) => state ? Math.max(state.retryAt, state.fetchedAt + minAge) : 0,
		forget: () => { state = undefined; },
	};
}
