import type {Quest} from "../types"
import {projectIdentity} from "../core/project"
export type BoardProject = {id?:string;root?:string;error?:string}
export function boardProject(directory:unknown){if(typeof directory!=="string"||!directory)return {id:undefined,error:"Project location unavailable; select All projects to inspect the shared ledger"};try{return {...projectIdentity(directory),error:undefined}}catch(error){return {id:undefined,error:error instanceof Error?error.message:"Project identity unavailable"}}}
export function projectQuests(quests:Quest[],projectID:string|undefined,allProjects=false){return allProjects?quests:quests.filter(q=>projectID!==undefined&&q.project?.id===projectID)}
export async function resolveBoardProject(context:any, sessionID?:string,returnDirectory?:string):Promise<BoardProject> {
  if(returnDirectory)return boardProject(returnDirectory)
  if (sessionID && typeof context?.client?.session?.get === "function") {
    try { const result=await context.client.session.get({sessionID});const row=result?.data??result;return boardProject(row?.id===sessionID?row.location?.directory:undefined) }
    catch { return {id:undefined,error:"Current session project could not be verified; select All projects"} }
  }
  return boardProject(context?.location?.directory??context?.state?.path?.directory)
}

export const allProjectsByDefault = (isUserGiver: unknown) => Boolean(isUserGiver)
export const scopeLabel = (allProjects: boolean, root?: string) =>
  allProjects ? "all projects" : "this project (" + (root?.split(/[\\/]/).filter(Boolean).at(-1) ?? "location unavailable") + ")"

export const strandedDiagnostic = (roots: string[]) => roots.length ? roots.length + " recorded project folder" + (roots.length === 1 ? " is" : "s are") + " gone, so Quests saved against " + roots.join(", ") + " can be read and moved but not started. Move one with update projectRoot." : undefined
