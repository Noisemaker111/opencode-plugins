export const RELEASE_BRIDGE_PORTS = { JEV_BRIDGE_PORT: 3013 } as const
type Environment = Record<string, string | undefined>
const LOOPBACK = /^(http:\/\/127\.0\.0\.1:)(\d+)(\/.*)?$/

export function bridgeAddress(address: string, env: Environment = process.env): string {
  const match = LOOPBACK.exec(address)
  if (!match) return address
  const variable = Object.entries(RELEASE_BRIDGE_PORTS).find(([, port]) => String(port) === match[2])?.[0]
  const port = variable && env[variable]?.trim()
  return port ? match[1] + port + (match[3] ?? "") : address
}
