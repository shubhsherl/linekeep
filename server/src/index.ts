import { createApp } from "./app";
import { istDate, sendCallSummary } from "./reporting/call-summary";
import { purgeExpiredRecordings, retentionDays } from "./retention/recordings";
import { purgeExpiredActivity } from "./retention/activity";
import { purgeStaleAttachments } from "./retention/attachments";
import { jobKeys } from "./settings/fields";
import { readJob, writeJob } from "./settings/jobs";
import { applySettings, loadSettings } from "./settings/service";

import type { Env } from "./env";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, deployment: Env) {
    // The cron fires every 30 minutes; each job decides whether it is due. Settings saved in the dashboard
    // override the deployment variables here exactly as they do for requests.
    const env = applySettings(deployment, await loadSettings(deployment));
    // Independent jobs: one failing must not skip the other. Rethrow afterwards so Cron Events shows the failure.
    const failures: unknown[] = [];
    try {
      await sendCallSummary(controller.scheduledTime, env);
    } catch (error) {
      failures.push(error);
    }
    try {
      // Retention runs once per IST day, at the first tick after midnight; a failed run is retried on the next tick.
      const today = istDate(controller.scheduledTime);
      if (retentionDays(env) !== null && (await readJob<{ date?: unknown }>(env.DB, jobKeys.retentionLastRun))?.date !== today) {
        const result = await purgeExpiredRecordings(env);
        // Counts only: never object keys, employee or call details.
        if (result.status === "done") console.log(JSON.stringify({ job: "recording-retention", ...result }));
        await writeJob(env, jobKeys.retentionLastRun, { date: today });
      }
    } catch {
      failures.push(new Error("Recording retention failed"));
    }
    try {
      // Abandoned chat uploads are removed once per IST day.
      const today = istDate(controller.scheduledTime);
      if ((await readJob<{ date?: unknown }>(env.DB, jobKeys.attachmentsLastRun))?.date !== today) {
        const removed = await purgeStaleAttachments(env);
        if (removed > 0) console.log(JSON.stringify({ job: "whatsapp-attachment-cleanup", removed }));
        await writeJob(env, jobKeys.attachmentsLastRun, { date: today });
      }
    } catch {
      failures.push(new Error("WhatsApp attachment cleanup failed"));
    }
    try {
      // Old activity log rows are removed once per IST day.
      const today = istDate(controller.scheduledTime);
      if ((await readJob<{ date?: unknown }>(env.DB, jobKeys.activityLastRun))?.date !== today) {
        const removed = await purgeExpiredActivity(env, new Date(controller.scheduledTime));
        if (removed > 0) console.log(JSON.stringify({ job: "activity-retention", removed }));
        await writeJob(env, jobKeys.activityLastRun, { date: today });
      }
    } catch {
      failures.push(new Error("Activity log retention failed"));
    }
    if (failures.length) throw failures[0];
  },
};
