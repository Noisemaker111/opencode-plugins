export type StepReport = { ref: string; status: "done" | "blocked" | "working" | "pending"; evidence: string }
export type TestReport = { command: string; result: "passed" | "failed" }
export type WorkerReport = { steps: StepReport[]; tests: TestReport[] }

const STEP = /^\s*(?:[-*]\s*)?STEP\s+([^:]+?)\s*:\s*(done|blocked|working|pending)\b\s*(?:[—–:-]+|->)?\s*(.*)$/i
const TEST = /^\s*(?:[-*]\s*)?TESTS?\s*:\s*(.+?)\s*(?:[—–:-]+|->)\s*(passed|failed)\b/i

export function parseWorkerReport(text: string): WorkerReport {
  const steps: StepReport[] = []
  const tests: TestReport[] = []
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/[`*_]/g, "")
    const step = STEP.exec(line)
    if (step) { steps.push({ ref: step[1].trim(), status: step[2].toLowerCase() as StepReport["status"], evidence: step[3].trim() }); continue }
    const test = TEST.exec(line)
    if (test) tests.push({ command: test[1].trim(), result: test[2].toLowerCase() as TestReport["result"] })
  }
  return { steps, tests }
}
