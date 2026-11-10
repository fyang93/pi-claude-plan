export interface UsageWindow {
	utilization?: number;
	resets_at?: string | null;
}
export interface UsageLimit {
	kind?: string;
	percent?: number;
	resets_at?: string | null;
	scope?: { model?: { display_name?: string | null } | null } | null;
}
export interface UsageResponse {
	five_hour?: UsageWindow | null;
	seven_day?: UsageWindow | null;
	seven_day_fable?: UsageWindow | null;
	fable_seven_day?: UsageWindow | null;
	limits?: UsageLimit[] | null;
}
export interface QuotaView { usage?: UsageResponse; error?: string }
export type Color = "text" | "muted" | "dim" | "warning" | "error" | "accent";
export interface Paint {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

export function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor(minutes % 1440 / 60);
	if (days) return `${days}d${hours ? `${hours}h` : ""}`;
	if (hours) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
	return `${minutes}m`;
}

function remainingColor(remaining: number): Color {
	return remaining < 25 ? "error" : remaining < 50 ? "warning" : "muted";
}

interface WindowView {
	label: string;
	used: number;
	reset?: string;
}

function windows(usage: UsageResponse | undefined, now: number): WindowView[] {
	const fable = usage?.limits?.find(limit => limit.kind === "weekly_scoped"
		&& limit.scope?.model?.display_name?.trim().toLowerCase() === "fable"
		&& Number.isFinite(limit.percent));
	const candidates: [string, UsageWindow | null | undefined][] = [
		["5h", usage?.five_hour],
		["All", usage?.seven_day],
		["Fable", fable ? { utilization: fable.percent, resets_at: fable.resets_at }
			: usage?.seven_day_fable ?? usage?.fable_seven_day],
	];
	return candidates.filter((item): item is [string, UsageWindow] => Number.isFinite(item[1]?.utilization))
		.map(([label, window]) => {
			const resetAt = window.resets_at ? Date.parse(window.resets_at) : Number.NaN;
			return {
				label,
				used: Math.round(Math.max(0, Math.min(100, window.utilization!))),
				reset: Number.isFinite(resetAt) ? formatDuration(resetAt - now) : undefined,
			};
		});
}

interface Segment {
	plain: string;
	paint(paint: Paint, barWidth: number): string;
	bar?: number;
}
const DIVIDER = " │ ";
const MIN_BAR = 4;
const textSegment = (text: string, color: Color): Segment => ({
	plain: text,
	paint: paint => paint.fg(color, text),
});

function windowSegment(window: WindowView, bar: boolean, resetTime: boolean): Segment {
	const reset = resetTime && window.reset ? ` ${window.reset}` : "";
	const color = remainingColor(100 - window.used);
	return {
		plain: `${window.label}${reset}${bar ? " " : ""} ${window.used}%`,
		bar: bar ? window.used : undefined,
		paint: (paint, barWidth) => {
			const filled = Math.round(window.used / 100 * barWidth);
			const progress = bar ? `${paint.fg(color, "━".repeat(filled))}${paint.fg("dim", "━".repeat(barWidth - filled))} ` : "";
			return `${paint.bold(paint.fg(color, window.label))}${paint.fg(color, reset)} ${progress}${paint.fg(color, `${window.used}%`)}`;
		},
	};
}

// As in Codex: shrink bars, drop the title, then compact; weekly quotas outlast 5h.
const DETAILS = [
	{ title: true, bar: true, reset: true, windows: 3 },
	{ title: false, bar: true, reset: true, windows: 3 },
	{ title: false, bar: false, reset: true, windows: 3 },
	{ title: false, bar: false, reset: false, windows: 3 },
	{ title: false, bar: false, reset: false, windows: 2 },
	{ title: false, bar: false, reset: false, windows: 1 },
];

export function renderQuota(view: QuotaView, width: number, paint: Paint, now = Date.now()): string[] {
	width = Math.max(0, Math.floor(width));
	const items = windows(view.usage, now);
	for (const detail of DETAILS) {
		const selected = detail.windows === 1
			? [items.find(item => item.label === "All") ?? items.at(-1)].filter((item): item is WindowView => Boolean(item))
			: items.slice(-detail.windows);
		const segments: Segment[] = [];
		if (detail.title) segments.push({ plain: "Claude", paint: paint => paint.bold(paint.fg("text", "Claude")) });
		if (view.error) segments.push(textSegment(view.error, "dim"));
		segments.push(...selected.map(item => windowSegment(item, detail.bar, detail.reset)));
		// Measure plain text, never ANSI-styled strings, when allocating space for bars.
		const textWidth = segments.reduce((sum, segment) => sum + [...segment.plain].length, 0)
			+ DIVIDER.length * Math.max(0, segments.length - 1);
		const bars = segments.filter(segment => segment.bar !== undefined).length;
		if (textWidth + bars * MIN_BAR > width) continue;
		const barWidth = bars ? Math.floor((width - textWidth) / bars) : 0;
		return [segments.map(segment => segment.paint(paint, barWidth)).join(paint.fg("dim", DIVIDER)), paint.fg("dim", "─".repeat(width))];
	}
	const error = view.error ? [...view.error] : [];
	return [error.length && width ? paint.fg("dim", error.length <= width ? view.error! : `${error.slice(0, width - 1).join("")}…`) : "",
		paint.fg("dim", "─".repeat(width))];
}
