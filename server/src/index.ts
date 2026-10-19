import { createApp } from "./app";
import { sendCallSummary } from "./reporting/call-summary";
import { purgeExpiredRecordings } from "./retention/recordings";

import type { Env } from "./env";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env) {
    // Independent jobs: one failing must not skip the other. Rethrow afterwards so Cron Events shows the failure.
    const failures: unknown[] = [];
    try {
      await sendCallSummary(controller.scheduledTime, env);
    } catch (error) {
      failures.push(error);
    }
    try {
      const result = await purgeExpiredRecordings(env);
      // Counts only: never object keys, employee or call details.
      if (result.status === "done") console.log(JSON.stringify({ job: "recording-retention", ...result }));
    } catch {
      failures.push(new Error("Recording retention failed"));
    }
    if (failures.length) throw failures[0];
  },
};
