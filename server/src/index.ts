import { createApp } from "./app";
import { sendCallSummary } from "./reporting/call-summary";

import type { Env } from "./env";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env) {
    await sendCallSummary(controller.scheduledTime, env);
  },
};
