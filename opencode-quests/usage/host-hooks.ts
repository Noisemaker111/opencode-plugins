import { installUsageHooks } from "../usage-service/on-computer"
import { recordQuotaObservations } from "./calibration-store"
import { timed } from "../scripts/plugin-spans"

export function installUsageHostHooks(): void {
  installUsageHooks({
    recorded: (snapshot, file) => recordQuotaObservations(snapshot, file + ".observations"),
    refreshed: (snapshot, options) => {
      void import("./plan-capacity-scan")
        .then(module => module.refreshPlanCapacityFromMeter(snapshot, options))
        .catch(() => undefined)
    },
    span: (name, run) => timed({ plugin: "usage", name }, run),
  })
}

installUsageHostHooks()
