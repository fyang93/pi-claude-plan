export interface UsageWindow { utilization?: number; resets_at?: string | null }
export interface UsageResponse { five_hour?: UsageWindow | null; seven_day?: UsageWindow | null; seven_day_sonnet?: UsageWindow | null; }
export interface QuotaView { usage?: UsageResponse; error?: string }
export type Color = "text" | "muted" | "dim" | "warning" | "error" | "accent";
export interface Paint { fg(color: Color, text: string): string; bold(text: string): string }
export function formatDuration(ms: number): string { const s=Math.max(0,Math.floor(ms/1000)),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60); return d?`${d}d${h?`${h}h`:``}`:h?`${h}h${m?`${m}m`:``}`:`${m}m`; }
function color(left:number): Color { return left<25?"error":left<50?"warning":"muted" }
export function renderQuota(view:QuotaView,width:number,paint:Paint,now=Date.now()):string[] {
 const items=[...[ ["5h",view.usage?.five_hour], ["Week",view.usage?.seven_day], ["Sonnet",view.usage?.seven_day_sonnet] ] as const].filter((x):x is [string,UsageWindow]=>!!x[1]&&typeof x[1].utilization==="number");
 const make=(title:boolean,bar:boolean,resetTime:boolean,windows:number)=>{
  const selected=items.slice(-windows); const parts:string[]=[];
  if(title)parts.push(paint.bold(paint.fg("text","Claude")));
  if(view.error)parts.push(paint.fg("dim",view.error));
  for(const [label,w] of selected){const used=Math.round(Math.max(0,Math.min(100,w.utilization!))),left=100-used,c=color(left),reset=resetTime&&w.resets_at?formatDuration(Date.parse(w.resets_at)-now):"";const widthForBar=bar?Math.max(4,Math.floor((width-30)/Math.max(1,selected.length))):0;const fill=Math.round(used/100*widthForBar);parts.push(`${paint.bold(paint.fg(c,label))}${reset?` ${paint.fg(c,reset)}`:""}${bar?` ${paint.fg(c,"━".repeat(fill))}${paint.fg("dim","━".repeat(widthForBar-fill))}`:""} ${paint.fg(c,`${used}%`)}`)}
  return parts.join(paint.fg("dim"," │ "));
 };
 const candidates=[[true,true,true,3],[true,true,true,2],[false,true,true,2],[false,false,true,2],[false,false,false,2],[false,false,false,1]] as const;
 let line=candidates.map(c=>make(...c)).find(s=>[...s.replace(/\x1b\\[[0-9;]*m/g,"")].length<=width)||"";
 if(!line&&view.error)line=paint.fg("dim",view.error.slice(0,Math.max(0,width-1))+"…");
 return [line,paint.fg("dim","─".repeat(Math.max(1,width)))];
}
