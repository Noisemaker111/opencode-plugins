import { Duration, Effect, Schedule } from 'effect'

const tables = new WeakMap<object, readonly number[]>()

export const delayTable = (schedule: Schedule.Schedule<number, void>, attempts: number): readonly number[] => {
  const held = tables.get(schedule)
  if (held) return held
  const delays: number[] = Effect.runSync(Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule)
    const values: number[] = []
    for (let attempt = 0; attempt < attempts; attempt++) {
      const [, delay] = yield* step(0, undefined)
      values.push(Duration.toMillis(delay))
    }
    return values
  }))
  tables.set(schedule, delays)
  return delays
}

export const delayMsOf = (schedule: Schedule.Schedule<number, void>, attempt: number, attempts = 32): number => {
  const delays = delayTable(schedule, attempts)
  return attempt <= 1 ? delays[0]! : delays[Math.min(attempt - 1, delays.length - 1)]!
}
