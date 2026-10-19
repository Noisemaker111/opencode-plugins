export const ALLOWED_TAGS=new Set(['div','span','p','h1','h2','h3','h4','ul','ol','li','table','thead','tbody','tfoot','tr','th','td','strong','em','b','i','u','small','code','pre','br','hr','a','section','header','footer','details','summary','dl','dt','dd','blockquote','sup','sub','time','progress','meter','caption'])
const VOID_TAGS=new Set(['br','hr'])
const DROPPED_TAGS=new Set(['script','style','iframe','object','embed','svg','math','template','noscript','link','meta','base','form','input','button','textarea','select','option','img','video','audio','source','canvas','frame','frameset'])
const DROP_WITH_CONTENT=new Set(['script','style','iframe','object','svg','math','template','noscript','form','textarea','select','button','video','audio','canvas','frameset'])
const ALLOWED_ATTRIBUTES=new Set(['class','style','title','href','target','rel','colspan','rowspan','datetime','value','max','min','low','high','optimum','open','lang','dir','role','aria-label'])
const SAFE_HREF=/^(https?:\/\/|mailto:|#|\/(?!\/))/i
const UNSAFE_STYLE=/(url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding|\\|<)/i
const SAFE_STYLE_DECLARATION=/^[a-z-]+\s*:\s*[^;{}]+$/i

export const escapeHtml=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')

function cleanAttributes(raw:string,tag:string){
 const out:string[]=[]
 const pattern=/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g
 let match:RegExpExecArray|null
 while((match=pattern.exec(raw))){
  const name=match[1].toLowerCase(),value=match[2]??match[3]??match[4]
  if(!ALLOWED_ATTRIBUTES.has(name)&&!name.startsWith('data-'))continue
  if(name.startsWith('on'))continue
  if(value===undefined){out.push(name);continue}
  if(name==='href'){if(!SAFE_HREF.test(value.trim()))continue;out.push('href="'+escapeHtml(value.trim())+'" target="_blank" rel="noopener noreferrer"');continue}
  if(name==='target'||name==='rel')continue
  if(name==='style'){
   const declarations=value.split(';').map(part=>part.trim()).filter(part=>part&&SAFE_STYLE_DECLARATION.test(part)&&!UNSAFE_STYLE.test(part))
   if(declarations.length)out.push('style="'+escapeHtml(declarations.join('; '))+'"')
   continue
  }
  if(tag==='a'&&name==='target')continue
  out.push(name+'="'+escapeHtml(value)+'"')
 }
 return out.length?' '+out.join(' '):''
}

export function sanitizeArtifactHtml(html:string):string{
 const source=String(html??'').replace(/<!--[\s\S]*?-->/g,'')
 let out='',index=0,dropUntil:string|undefined
 const tagPattern=/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\s*\/?>/g
 let match:RegExpExecArray|null
 while((match=tagPattern.exec(source))){
  const text=source.slice(index,match.index)
  index=match.index+match[0].length
  const tag=match[1].toLowerCase(),closing=match[0].startsWith('</')
  if(dropUntil){if(closing&&tag===dropUntil)dropUntil=undefined;continue}
  out+=escapeHtml(text)
  if(DROPPED_TAGS.has(tag)){if(!closing&&DROP_WITH_CONTENT.has(tag)&&!match[0].endsWith('/>'))dropUntil=tag;continue}
  if(!ALLOWED_TAGS.has(tag))continue
  if(closing){if(!VOID_TAGS.has(tag))out+='</'+tag+'>';continue}
  out+='<'+tag+cleanAttributes(match[2]??'',tag)+(VOID_TAGS.has(tag)?'>':'>')
 }
 if(!dropUntil)out+=escapeHtml(source.slice(index))
 return out
}

export const artifactStyles={
 card:'font:13px/1.45 system-ui,sans-serif;color:var(--ink,#18181b);background:var(--panel,#fff);border:1px solid var(--line,#e3e3de);border-radius:12px;padding:12px 14px;max-width:720px',
 title:'margin:0 0 6px;font-size:14px;font-weight:600;color:var(--ink,#18181b)',
 muted:'color:var(--muted,#71717a)',
 soft:'color:var(--ink-soft,#3f3f46)',
 row:'display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--line,#e3e3de)',
 chip:'display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:500;background:var(--sunken,#efefec);color:var(--muted,#71717a)',
 chipAccent:'display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:500;background:var(--accent-soft,#e3efe9);color:var(--accent,#2f6f5e)',
 chipYou:'display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:500;background:var(--you-soft,#fbeee4);color:var(--you,#b4541a)',
 chipDanger:'display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:500;background:var(--sunken,#efefec);color:var(--danger,#b42318)',
 table:'width:100%;border-collapse:collapse;font-size:12.5px',
 cell:'padding:4px 6px;border-top:1px solid var(--line,#e3e3de);text-align:left;vertical-align:top',
 head:'padding:2px 6px;font-size:11px;font-weight:500;text-align:left;color:var(--muted,#71717a)',
 meter:'position:relative;height:6px;border-radius:999px;background:var(--sunken,#efefec);overflow:hidden',
 fill:'position:absolute;inset:0 auto 0 0;border-radius:999px;background:var(--accent,#2f6f5e)',
}
