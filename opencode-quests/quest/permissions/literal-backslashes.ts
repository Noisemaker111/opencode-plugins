const MEANINGFUL=new Set([...'\\\'"bfnrtv0xu\n\r\u2028\u2029'])
const WRITTEN_ON_PURPOSE=new Set([...'/$`{}'])
const BEFORE_EXPRESSION=new Set(['return','typeof','instanceof','in','of','new','delete','void','throw','case','do','else','yield','await'])
const WORD=/[\w$\u0080-\uffff]/

export function keepLiteralBackslashes(code:string):string{
 let out='',i=0,expressionNext=true
 const frames:{template:boolean;tagged:boolean;depth:number}[]=[{template:false,tagged:false,depth:0}]
 const escape=(raw:boolean)=>{
  const next=code[i+1]??'',width=next==='\r'&&code[i+2]==='\n'?3:next?2:1
  out+=raw||!next||MEANINGFUL.has(next)||WRITTEN_ON_PURPOSE.has(next)?code.slice(i,i+width):'\\\\'+next
  i+=width
 }
 while(i<code.length){
  const frame=frames.at(-1)!,c=code[i]!
  if(frame.template){
   if(c==='\\'){escape(frame.tagged);continue}
   if(c==='`'){frames.pop();out+=c;i++;expressionNext=false;continue}
   if(c==='$'&&code[i+1]==='{'){frames.push({template:false,tagged:false,depth:0});out+='${';i+=2;expressionNext=true;continue}
   out+=c;i++;continue
  }
  if(c==='"'||c==="'"){
   out+=c;i++
   while(i<code.length&&code[i]!==c&&code[i]!=='\n'){if(code[i]==='\\'){escape(false);continue}out+=code[i++]}
   if(i<code.length)out+=code[i++]
   expressionNext=false;continue
  }
  if(c==='`'){frames.push({template:true,tagged:!expressionNext,depth:0});out+=c;i++;continue}
  if(c==='/'&&code[i+1]==='/'){const end=code.indexOf('\n',i);const stop=end<0?code.length:end;out+=code.slice(i,stop);i=stop;continue}
  if(c==='/'&&code[i+1]==='*'){const end=code.indexOf('*/',i+2);const stop=end<0?code.length:end+2;out+=code.slice(i,stop);i=stop;continue}
  if(c==='/'&&expressionNext){
   let j=i+1,inClass=false
   while(j<code.length&&code[j]!=='\n'){const d=code[j];if(d==='\\'){j+=2;continue}if(d==='[')inClass=true;else if(d===']')inClass=false;else if(d==='/'&&!inClass)break;j++}
   j++
   while(j<code.length&&WORD.test(code[j]!))j++
   out+=code.slice(i,j);i=j;expressionNext=false;continue
  }
  if(WORD.test(c)){
   let j=i+1
   while(j<code.length&&WORD.test(code[j]!))j++
   const word=code.slice(i,j)
   out+=word;i=j;expressionNext=BEFORE_EXPRESSION.has(word);continue
  }
  if(/\s/.test(c)){out+=c;i++;continue}
  if(c==='{'){frame.depth++;out+=c;i++;expressionNext=true;continue}
  if(c==='}'){
   if(frame.depth===0&&frames.length>1){frames.pop();out+=c;i++;continue}
   frame.depth=Math.max(0,frame.depth-1);out+=c;i++;expressionNext=false;continue
  }
  out+=c;i++;expressionNext=c!==')'&&c!==']'
 }
 return out
}

export async function installLiteralBackslashes(ctx:{tool?:{hook?:Function}}){
 const hook=ctx?.tool?.hook
 if(typeof hook!=='function')return
 await hook('execute.before',(event:any)=>{
  const input=event?.input
  if(event?.tool!=='execute'||!input||typeof input.code!=='string')return
  const kept=keepLiteralBackslashes(input.code)
  if(kept!==input.code)input.code=kept
 })
}
