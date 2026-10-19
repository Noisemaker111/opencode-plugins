import type { Quest } from '../types'

export type PullRequestEvidence = { url: string; label: string; sources: { label: string; stepID?: string }[] }

export function questPullRequests(q: Quest): PullRequestEvidence[] {
 const links = new Map<string, PullRequestEvidence>()
 const add = (text: string | undefined, label: string, stepID?: string) => {
  for (const match of (text ?? '').matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
   let url: URL
   try { url = new URL(match[0].replace(/[),.;\]}]+$/, '')) } catch { continue }
   if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) continue
   const path = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/|$)/)
   if (!path) continue
   const [, owner, repo, number] = path
   const canonical = `https://github.com/${owner}/${repo}/pull/${number}`
   const key = canonical.toLowerCase()
   const entry: PullRequestEvidence = links.get(key) ?? { url: canonical, label: `${owner}/${repo} #${number}`, sources: [] }
   if (!entry.sources.some(source => source.label === label && source.stepID === stepID)) entry.sources.push({ label, ...(stepID ? { stepID } : {}) })
   links.set(key, entry)
  }
 }
 for (const artifact of q.evidence.artifacts) { add(artifact.uri, `Artifact: ${artifact.name}`); add(artifact.path, `Artifact: ${artifact.name}`) }
 for (const step of q.stages) {
  add(step.note, `Saved note: ${step.title}`, step.id)
  for (const proof of step.proofs) { add(proof.artifact, `Saved proof: ${step.title}`, step.id); add(proof.reason, `Saved proof: ${step.title}`, step.id) }
 }
 for (const run of q.sessions) {
  const label = `Worker outcome: ${run.sessionTitle ?? run.sessionRef ?? run.role}`
  add(run.result, label)
  for (const evidence of run.evidence) add(evidence, label)
 }
 for (const deliverable of q.deliverables ?? []) for (const evidence of deliverable.evidence ?? []) add(evidence, `Deliverable: ${deliverable.title}`)
 for (const check of q.evidence.tests ?? []) add(check.summary, 'Saved test result', check.stepID)
 add(q.evidence.review?.evidence, 'Saved review')
  for (const publish of q.evidence.publish) add(publish.target, 'Saved publish evidence')
  const drafts = q.extensions.studioDrafts
  if (Array.isArray(drafts)) for (const draft of drafts) if (draft && typeof draft === 'object') add((draft as any).promotion?.url, 'Design Studio draft')
  return [...links.values()]
}
