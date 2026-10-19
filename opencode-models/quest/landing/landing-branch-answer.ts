import { WORK_BRANCH, RELEASE_BRANCH, LEGACY_CHANNEL_NAMES } from "../channel.mjs"

const NON_LANDING_NAMES = [RELEASE_BRANCH, ...Object.keys(LEGACY_CHANNEL_NAMES).filter(name => name !== "latest" && name !== "dev")]
const INTO_NON_LANDING = new RegExp("(?:^|[^a-z])(?:into|onto|to|on|against|base|origin/)[ `]*(?:" + NON_LANDING_NAMES.join("|") + ")(?![a-z])", "i")
const DELIVERY_ACT = /(?:^|[^a-z])(?:merge|merging|pull request|PRs?|gh pr|rebase|retarget|base|land|landing)(?![a-z])/i
const RELEASE_ACT = /(?:^|[^a-z])(?:release|promot|deploy|publish)/i

export const LANDING_BRANCH_ANSWER = `${WORK_BRANCH} is the only landing branch, so this has one answer and the user is not asked: base the work on ${WORK_BRANCH}, open any pull request into ${WORK_BRANCH} and land it with the project lander. Branch names in step titles, ids and notes are legacy labels.`

export function wrongLandingBranchBlock(parts: (string | undefined)[]): boolean {
  const text = parts.filter(Boolean).join(" ")
  return INTO_NON_LANDING.test(text) && DELIVERY_ACT.test(text) && !RELEASE_ACT.test(text)
}
