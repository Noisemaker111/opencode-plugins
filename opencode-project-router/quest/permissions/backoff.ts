import { Duration, Schedule } from 'effect'
import { delayMsOf } from '../core/backoff'

export const PERMISSION_RETRY_SCHEDULE: Schedule.Schedule<number, void> = Schedule.min([
  Schedule.exponential(Duration.seconds(5)),
  Schedule.spaced(Duration.seconds(300)),
])

export const permissionRetryMs = (attempt: number): number => delayMsOf(PERMISSION_RETRY_SCHEDULE, attempt)
