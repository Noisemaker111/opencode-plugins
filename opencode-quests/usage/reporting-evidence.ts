import type { AccountUsage, AccountWindow } from '../usage-service/on-computer'

export function accountEvidence(account: AccountUsage) {
  const missing = Object.entries(account.plan).filter(([, value]) => value == null).map(([field]) => 'plan.' + field)
  if (account.extraUsage.enabled == null) missing.push('extraUsage.enabled')
  return {
    missingFields: missing,
    reason: missing.length ? account.observedAt ? 'Not reported by the recorded account observation; plan names do not establish tiers or multipliers.' : 'No account observation has been recorded.' : undefined,
    freshness: account.freshness?.stale ? 'Last known values; refresh the provider observation for current availability.' : undefined,
  }
}

export function windowEvidence(window: AccountWindow) {
  const missingFields = ['usedPercent', 'remainingPercent', 'resetAt'].filter(field => window[field as keyof AccountWindow] == null)
  return {
    missingFields,
    reason: missingFields.length ? 'Not reported by the recorded quota observation; availability does not establish a percentage or reset.' : undefined,
    scope: window.scope === 'unknown' ? 'The provider window name has no verified shared, model or feature binding.' : undefined,
  }
}
