export interface UsageWindow { utilization?: number; resets_at?: string | null }
export interface UsageResponse { five_hour?: UsageWindow | null; seven_day?: UsageWindow | null; seven_day_sonnet?: UsageWindow | null; }
export interface QuotaView { usage?: UsageResponse; error?: string }
export type Color = "text" | "muted" | "dim" | "warning" | "error" | "accent";
export interface Paint { fg(color: Color, text: string): string; bold(text: string): string }
export function formatDuration(ms: number): string { const s=Math.max(0,Math.floor(ms/1000)),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60); return d?`${d}d${h?`${h}h`:``}`:h?`${h}h${m?`${m}m`:``}`:`${m}m`; }
function color(left:number): Color { return left<25?"error":left<50?"warning":"muted" }
export function renderQuota(view:QuotaView,width:number,paint:Paint,now=Date.now()):string[] {
 const items=[...[ ["5h",view.usage?.five_hour], ["Week",view.usage?.seven_day], ["Sonnet",view.usage?.seven_day_sonnet] ] as const].filter((x):x is [string,UsageWindow]=>!!x[1]&&typeof x[1].utilization==="number");
 let line=view.error||items.map(([label,w])=>{const used=Math.round(Math.max(0,Math.min(100,w.utilization!))), left=100-used, reset=w.resets_at?formatDuration(Date.parse(w.resets_at)-now):""; return `${paint.bold(paint.fg(color(left),label))}${reset?` ${paint.fg(color(left),reset)}`:""} ${paint.fg(color(left),`${used}%`)}`}).join(" │ ");
 if(line.length>width) line=line.slice(0,Math.max(0,width-1))+"…";
 return [line,paint.fg("dim","─".repeat(Math.max(1,width)))];
}
