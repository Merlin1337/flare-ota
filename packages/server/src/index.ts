import { createApp } from "./app.ts";
import type { Ctx, Env } from "./env.ts";
import { Services } from "./services.ts";
import { Store } from "./store.ts";

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: Ctx) {
    return app.fetch(request, env, ctx as never);
  },
  // Daily garbage collection (see the cron trigger in cloudflare.config.ts).
  async scheduled(_event: unknown, env: Env, ctx: Ctx) {
    ctx.waitUntil(new Services(new Store(env.DB), env).collectGarbage("cron").then((summary) => console.log("gc", JSON.stringify(summary))));
  },
};
