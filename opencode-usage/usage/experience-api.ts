import { usageReferences } from './session-references'
import { usageExperience, type ExperienceQuery } from "./experience"
import { readAccountUsage, ACCOUNT_USAGE_FILE } from "../usage-service/on-computer"
import { readQuotaObservations } from "./calibration-store"
import { readLedger } from "./passive-ledger"
import { readUsageTargets } from "./usage-target"
import { readBurnControls } from "./burn-control"

export function getUsageExperience(input: ExperienceQuery) {
  const references=usageReferences()
  input=references.resolve(input)
  const now=Date.now(),snapshot=readAccountUsage(undefined,now)
  const from=input.from??(input.resetAt??now)-7*86400000,to=input.to??now
  const quota=readQuotaObservations(ACCOUNT_USAGE_FILE+".observations",{from})
  const ledger=readLedger({from,to})
  const value=usageExperience({now,accounts:snapshot.accounts,observations:[...quota.observations,...ledger.observations],requests:ledger.rows,targets:readUsageTargets(),controls:readBurnControls(),collectorAt:ledger.receipt?.at,hostScanAt:ledger.receipt?.hostScanAt,coverageFrom:ledger.coverageFrom,counterGaps:ledger.gaps,diagnosticCount:snapshot.diagnostics.length+quota.diagnostics.length+ledger.diagnostics.length+(ledger.receipt?.diagnostics.length??0)},input)
  return { ...value, resolvedSession: references.session(input.sessionID,input.source), activity: {...value.activity,...references.fields({sessionID:input.sessionID,source:input.source})}, requests:value.requests?{...value.requests,items:value.requests.items.map(row=>({...row,...references.fields(row)}))}:null }
}
