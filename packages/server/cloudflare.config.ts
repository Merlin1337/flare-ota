// flare-ota Worker. Every account-specific value comes from the environment (see .env.example);
// D1 and R2 are found or created by name on deploy, so the repo holds no resource IDs.
//
//   cf deploy                  -> production Worker  (FLARE_OTA_NAME, default "flare-ota")
//   cf deploy --mode staging   -> separate Worker    ("<name>-staging"), its own D1 and R2
import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const env = (key: string) => process.env[key]?.trim() || undefined;

export default defineConfig(({ mode }) => {
  const base = env("FLARE_OTA_NAME") ?? "flare-ota";
  const name = mode === "staging" ? `${base}-staging` : base;
  const updatesHost = env("FLARE_OTA_UPDATES_HOST");
  const dashboardHost = env("FLARE_OTA_DASHBOARD_HOST");
  const vars: Record<string, ReturnType<typeof bindings.text>> = {};
  for (const key of ["DASHBOARD_HOST", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "APP_SCHEME"] as const) {
    const value = key === "DASHBOARD_HOST" ? dashboardHost : env(`FLARE_OTA_${key}`);
    if (value) vars[key] = bindings.text(value);
  }
  return {
    worker: {
      name,
      entrypoint,
      compatibilityDate: "2026-10-01",
      env: {
        DB: bindings.d1({ name: `${name}-db` }),
        BUCKET: bindings.r2({ name: `${name}-assets` }),
        // Opt-in: Analytics Engine must first be enabled once per account in the dashboard.
        ...(env("FLARE_OTA_ANALYTICS") === "on" ? { EVENTS: bindings.analyticsEngineDataset({ name: `${name.replaceAll("-", "_")}_events` }) } : {}),
        SIGNING_KEY: bindings.secret(),
        PREVIEW_SECRET: bindings.secret(),
        ...vars,
      },
      triggers: [triggers.scheduled({ schedule: "17 3 * * *" })],
      // Custom domains only: workers.dev stays off so nothing bypasses Access or the WAF.
      domains: [updatesHost, dashboardHost].filter((host): host is string => Boolean(host)),
      workersDev: false,
      observability: { enabled: true },
    },
  };
});
