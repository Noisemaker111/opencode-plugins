export default {
 id:'search-output',
 async setup(host){
  await host.tool.hook('execute.after',event=>{
   if(event.tool!=='grep'||event.status!=='completed'||event.result.metadata?.outputPath)return
   const {truncated,...metadata}=event.result.metadata??{}
   if(typeof truncated!=='boolean')return
   event.result={...event.result,metadata:{...metadata,searchTruncated:truncated}}
  })
 },
}
