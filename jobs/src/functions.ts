import { app, type InvocationContext } from "@azure/functions";
import { scrubLog } from "../../shared/logScrub";
import type { Logger } from "./common";
import { readConfig, type JobsConfig } from "./config";
import { runBackup, runCleanup, runPurge } from "./run";

// NCRONTAB expressions in UTC, staggered so the jobs never overlap.
const schedules = {
  backup: "0 0 2 * * *",
  purge: "0 0 3 * * *",
  cleanup: "0 0 4 * * *"
};

function logger(context: InvocationContext): Logger {
  return {
    info: (message) => context.log(scrubLog(message)),
    warn: (message) => context.warn(scrubLog(message)),
    error: (message) => context.error(scrubLog(message))
  };
}

function timer(name: keyof typeof schedules, job: (config: JobsConfig, log: Logger) => Promise<void>) {
  app.timer(name, {
    schedule: schedules[name],
    runOnStartup: false,
    handler: (_timer, context) => job(readConfig(), logger(context))
  });
}

timer("backup", (config, log) => runBackup(config, log));
timer("purge", (config, log) => runPurge(config, log));
timer("cleanup", (config, log) => runCleanup(config, log));
