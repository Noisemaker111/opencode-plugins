import { QUEST_ROUTES } from './config/registry.mts'

export function questWebURL(baseURL: string, token: string) {
  return baseURL.replace(/\/$/, '') + QUEST_ROUTES.web.path + '#access_token=' + encodeURIComponent(token)
}

export function questWebHTML() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quest Web</title><style>
:root{color-scheme:dark;font:15px/1.45 ui-sans-serif,system-ui,sans-serif;background:#0b0d10;color:#e8ebef}*{box-sizing:border-box}body{margin:0}header{position:sticky;top:0;z-index:2;padding:18px clamp(18px,4vw,52px);background:#0b0d10e8;border-bottom:1px solid #262b33;backdrop-filter:blur(12px)}h1{font-size:20px;margin:0}header p{margin:3px 0 0;color:#99a2ad}main{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:18px;padding:22px clamp(18px,4vw,52px)}section{min-width:0}.heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}h2{font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#aab3bd;margin:0}.stack{display:grid;gap:10px}.card{background:#14181e;border:1px solid #292f38;border-radius:12px;padding:14px 15px}.title{font-weight:650}.meta,.muted{color:#939daa;font-size:13px}.meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.pill{border:1px solid #343c47;border-radius:999px;padding:2px 8px}.bar{height:7px;background:#272e37;border-radius:99px;overflow:hidden;margin:10px 0 5px}.bar>i{display:block;height:100%;background:#7c9cff;border-radius:inherit}.error{border-color:#63323a;color:#ffb7c0}button{font:inherit;color:inherit;background:#20262e;border:1px solid #38414c;border-radius:8px;padding:6px 10px;cursor:pointer}button:hover{background:#29313b}button:focus-visible,select:focus-visible{outline:2px solid #7c9cff;outline-offset:2px}@media(max-width:820px){main{grid-template-columns:1fr}}
</style></head><body><header><h1>Quest Web</h1><p>Quests and account usage in one local surface.</p></header><main><section><div class="heading"><h2>Quests</h2><button id="refresh" type="button">Refresh</button></div><div id="quests" class="stack"><div class="card muted">Loading…</div></div></section><section><div class="heading"><h2>Usage</h2><label class="muted">Capture source <select id="usage-source"><option value="opencode">OpenCode</option><option value="codex">Codex</option><option value="opencode-host">OpenCode host</option></select></label></div><div id="usage" class="stack"><div class="card muted">Loading…</div></div></section></main><script>
const supplied=new URLSearchParams(location.hash.slice(1)).get('access_token');if(supplied)sessionStorage.setItem('quest-web-token',supplied);const token=supplied||sessionStorage.getItem('quest-web-token');history.replaceState(null,'',location.pathname);
const quests=document.querySelector('#quests'),usage=document.querySelector('#usage'),refresh=document.querySelector('#refresh');
const source=document.querySelector('#usage-source'),savedSource=sessionStorage.getItem('quest-web-usage-source');if(['opencode','codex','opencode-host'].includes(savedSource))source.value=savedSource;let usageRequest=0;
const node=(tag,className,text)=>{const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=String(text);return e};
const card=(title,meta=[])=>{const e=node('article','card');e.append(node('div','title',title));if(meta.length){const m=node('div','meta');for(const value of meta)m.append(node('span','pill',value));e.append(m)}return e};
const fail=(target,error)=>{target.replaceChildren(node('div','card error',error instanceof Error?error.message:String(error)))};
async function read(path){if(!token)throw Error('This Quest Web link has no access token.');const r=await fetch(path,{headers:{authorization:'Bearer '+token}});if(!r.ok){const data=await r.json().catch(()=>null);throw Error(data?.message||('HTTP '+r.status))}return r.json()}
function renderQuests(data){quests.replaceChildren();const items=Array.isArray(data.items)?data.items:[];if(!items.length){quests.append(node('div','card muted','No active Quests.'));return}for(const q of items){const done=q.progress?.done??0,total=q.progress?.total??0;const e=card(q.title||'Untitled Quest',[q.state||'Saved',total?done+' of '+total+' steps':'No steps']);if(total){const b=node('div','bar');const i=node('i');i.style.width=(done/total*100)+'%';b.append(i);e.append(b)}quests.append(e)}}
function renderUsage(data){
usage.replaceChildren();const accounts=Array.isArray(data.accounts)?data.accounts:[];
if(!accounts.length)usage.append(node('div','card muted','No account usage observation is recorded.'));
for(const a of accounts){
const e=card((a.provider||'Account')+(a.plan&&a.plan.name?' · '+a.plan.name:''),[a.state||'unknown',!a.observedAt?'no observation':a.freshness&&a.freshness.stale?'last known':'current']);
e.append(node('p','muted',a.observedAt?'Observed '+new Date(a.observedAt).toLocaleString():'No account observation has been recorded.'));
for(const w of a.windows||[]){
const used=typeof w.usedPercent==='number'&&Number.isFinite(w.usedPercent)?w.usedPercent:null,remaining=typeof w.remainingPercent==='number'&&Number.isFinite(w.remainingPercent)?w.remainingPercent:null;
const row=node('div');row.append(node('div','meta',(w.label||w.id)+' · '+(used===null?'usage not reported':used.toFixed(1)+'% used')+(remaining===null?'':' · '+remaining.toFixed(1)+'% remaining')));
if(used!==null){const b=node('div','bar');const i=node('i');i.style.width=Math.max(0,Math.min(100,used))+'%';b.append(i);row.append(b)}
row.append(node('div','muted',w.resetAt?'Resets '+new Date(w.resetAt).toLocaleString():'Reset not reported'));
if(w.evidence&&w.evidence.reason)row.append(node('p','muted',w.evidence.reason));if(w.evidence&&w.evidence.scope)row.append(node('p','muted',w.evidence.scope));e.append(row)
}
if(a.evidence&&a.evidence.reason)e.append(node('p','muted',(a.evidence.missingFields??[]).join(', ')+': '+a.evidence.reason));if(a.error)e.append(node('p','error',a.error));usage.append(e)
}
if(data.session){const s=data.session,e=card('Recorded '+s.source+' requests',[s.requests+' requests',s.sessions+' recorded sessions']);
for(const m of s.models||[])e.append(node('div','meta',m.providerID+'/'+m.modelID+' ('+(m.reasoning||'reasoning unknown')+', '+(m.harness||'harness unknown')+'): '+m.requests+' requests across '+m.sessions+' recorded sessions'));
e.append(node('p','muted',s.basis));if(s.evidence)for(const key of ['scope','accountBinding','cost','timing'])if(s.evidence[key])e.append(node('p','muted',s.evidence[key]));usage.append(e)}
if(data.collector){const c=data.collector,e=card('Collector',[c.state||'unknown',c.source]);if(c.reason)e.append(node('p','muted',c.reason));for(const d of c.diagnostics||[])e.append(node('p','muted',d));usage.append(e)}
}
async function loadUsage(){const current=++usageRequest;try{const data=await read('${QUEST_ROUTES.webUsage.path}?source='+encodeURIComponent(source.value));if(current===usageRequest)renderUsage(data)}catch(error){if(current===usageRequest)fail(usage,error)}}
let questRequest=0;async function loadQuests(){const current=++questRequest;refresh.disabled=true;try{const data=await read('${QUEST_ROUTES.webQuests.path}');if(current===questRequest)renderQuests(data)}catch(error){if(current===questRequest)fail(quests,error)}finally{if(current===questRequest)refresh.disabled=false}}
function load(){void loadQuests();void loadUsage()}source.addEventListener('change',()=>{sessionStorage.setItem('quest-web-usage-source',source.value);void loadUsage()});refresh.addEventListener('click',load);load();
</script></body></html>`
}
