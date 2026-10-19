import "./host-hooks"
import { localBackend, serveStdio, getAccountUsage } from "../usage-service/on-computer"

export const usageProductBackend = (options: { keyForm?: boolean } = {}) =>
  localBackend({ accounts: async refresh => (await getAccountUsage({ refresh })).accounts, ...options })

export async function serveUsageStdio() {
  await serveStdio(usageProductBackend())
}
