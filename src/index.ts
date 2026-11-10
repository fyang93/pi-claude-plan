import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderQuota, type QuotaView, type Paint, type UsageResponse } from "./quota.ts";

const BASE="https://api.anthropic.com";
const KEY="claude-plan";
const REFRESH=5*60_000;
function authPath(){return join(process.env.PI_CODING_AGENT_DIR||join(homedir(),".pi","agent"),"auth.json")}
async function token(){const raw=await readFile(authPath(),"utf8"); const a=JSON.parse(raw)?.anthropic; if(!a?.access) throw new Error("pi is not logged in to Anthropic. Run /login and pick Anthropic."); return a.access as string}
async function usage():Promise<UsageResponse>{const access=await token();const r=await fetch(`${BASE}/api/oauth/usage`,{headers:{Authorization:`Bearer ${access}`,"anthropic-beta":"oauth-2025-04-20"},signal:AbortSignal.timeout(20_000)});if(!r.ok)throw new Error(`Claude usage failed: HTTP ${r.status}`);return await r.json() as UsageResponse}
function errorText(e:unknown){return e instanceof Error?e.message:String(e)}
export default function(pi:ExtensionAPI){let view:QuotaView={};let timer:ReturnType<typeof setInterval>|undefined;let refreshing:Promise<void>|undefined;
 const paint=(ctx:ExtensionContext):Paint=>({fg:(c,t)=>ctx.ui.theme.fg(c,t),bold:t=>ctx.ui.theme.bold(t)});
 const render=(ctx:ExtensionContext)=>ctx.ui.setWidget(KEY,()=>({render:(w:number)=>renderQuota(view,w,paint(ctx)),invalidate:()=>{}}),{placement:"belowEditor"});
 const refresh=(ctx:ExtensionContext)=>{refreshing??=(async()=>{try{view={usage:await usage()};render(ctx)}catch(e){view={error:errorText(e)};render(ctx)}finally{refreshing=undefined}})();return refreshing};
 pi.on("session_start",async(_e,ctx)=>{if(!ctx.hasUI)return;void refresh(ctx);timer=setInterval(()=>void refresh(ctx),REFRESH);timer.unref?.()});
 pi.on("agent_end",async(_e,ctx)=>{if(ctx.hasUI)void refresh(ctx)});
 pi.on("session_shutdown",async(_e,ctx)=>{if(timer)clearInterval(timer);ctx.ui.setWidget(KEY,undefined)});
}
