export interface UsageWindow { utilization?: number; resets_at?: string | null }
export interface UsageLimit { kind?: string; percent?: number; resets_at?: string | null; scope?: { model?: { display_name?: string | null } | null } | null }
export interface UsageResponse { five_hour?: UsageWindow | null; seven_day?: UsageWindow | null; seven_day_fable?: UsageWindow | null; fable_seven_day?: UsageWindow | null; limits?: UsageLimit[] | null }
export interface QuotaView { usage?: UsageResponse; error?: string }
export type Color = "text" | "muted" | "dim" | "warning" | "error" | "accent";
export interface Paint { fg(color: Color, text: string): string; bold(text: string): string }
export function formatDuration(ms: number): string { const s=Math.max(0,Math.floor(ms/1000)),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60); return d?`${d}d${h?`${h}h`:``}`:h?`${h}h${m?`${m}m`:``}`:`${m}m`; }
function color(left:number): Color { return left<25?"error":left<50?"warning":"muted" }

export function renderQuota(view:QuotaView,width:number,paint:Paint,now=Date.now()):string[] {
 if(view.error)return [paint.fg("dim",view.error.slice(0,Math.max(0,width-1))+"…"),paint.fg("dim","─".repeat(Math.max(1,width)))];
 const usage=view.usage;
 const fableLimit=usage?.limits?.find(l=>l.kind==="weekly_scoped"&&l.scope?.model?.display_name?.toLowerCase()==="fable"&&typeof l.percent==="number");
 const items=[...[ ["5h",usage?.five_hour], ["All",usage?.seven_day], ["Fable",fableLimit?{utilization:fableLimit.percent,resets_at:fableLimit.resets_at}:usage?.seven_day_fable??usage?.fable_seven_day] ] as const].filter((x):x is [string,UsageWindow]=>!!x[1]&&typeof x[1].utilization==="number").map(([label,w])=>{const used=Math.round(Math.max(0,Math.min(100,w.utilization!)));return {label,used,color:color(100-used),reset:w.resets_at?formatDuration(Date.parse(w.resets_at)-now):undefined}});
 const divider=" │ ";
 const layouts=[{title:true,reset:true,bar:true},{title:true,reset:false,bar:true},{title:true,reset:true,bar:false},{title:true,reset:false,bar:false}];
 let line="";
 for(const layout of layouts){
  const parts=items.map(item=>`${item.label}${layout.reset&&item.reset?` ${item.reset}`:""}${layout.bar?"  ":" "}${item.used}%`);
  const base=(layout.title?"Claude".length+divider.length:0)+parts.join(divider).length;
  const barCount=layout.bar?items.length:0;
  if(base+barCount*4>width)continue;
  const barWidth=barCount?Math.floor((width-base)/barCount):0;
  const styled=items.map((item,index)=>{
   const label=paint.bold(paint.fg(item.color,item.label));
   const reset=layout.reset&&item.reset?` ${paint.fg(item.color,item.reset)}`:"";
   const bar=layout.bar?` ${paint.fg(item.color,"━".repeat(Math.round(item.used/100*barWidth)))}${paint.fg("dim","━".repeat(barWidth-Math.round(item.used/100*barWidth)))}`:"";
   return `${label}${reset}${bar} ${paint.fg(item.color,`${item.used}%`)}`;
  });
  line=`${layout.title?`${paint.bold(paint.fg("text","Claude"))}${items.length?divider:""}`:""}${styled.join(paint.fg("dim",divider))}`;
  break;
 }
 if(!line&&view.error)line=paint.fg("dim",view.error.slice(0,Math.max(0,width-1))+"…");
 return [line,paint.fg("dim","─".repeat(Math.max(1,width)))];
}
