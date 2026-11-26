import { backupTables } from "./backup";
import { blobUploader } from "./blob";
import { cleanupExpired } from "./cleanup";
import { describeError, type Logger } from "./common";
import type { JobsConfig } from "./config";
import { purgeExpired } from "./purge";
import { openBackupContainer, openTables } from "./tables";

export async function runBackup(config: JobsConfig, log: Logger, now = new Date()): Promise<void> {
  const container = openBackupContainer(config.backup, config.backupContainer);
  // Deployed containers are created (with immutability) by infrastructure; only emulators need creating.
  if (config.backup.kind === "connectionString") await container.createIfNotExists();
  const summary = await backupTables(openTables(config.data), blobUploader(container), now);
  const counts = Object.entries(summary.tables)
    .map(([table, rows]) => `${table}=${rows ?? "already backed up"}`)
    .join(", ");
  log.info(`Backup ${summary.date} finished: ${counts}.`);
}

export async function runPurge(config: JobsConfig, log: Logger, now = Date.now()): Promise<void> {
  try {
    const summary = await purgeExpired(openTables(config.data), now, log);
    log.info(
      `Purge finished: ${summary.households} households, ${summary.accounts} accounts, ${summary.rows} rows, `
      + `${summary.skipped} skipped, ${summary.failures} failed.`
    );
    if (summary.failures) throw new Error(`Purge left ${summary.failures} items for the next run.`);
  } catch (error) {
    log.error(`Purge failed (${describeError(error)}).`);
    throw error;
  }
}

export async function runCleanup(config: JobsConfig, log: Logger, now = Date.now()): Promise<void> {
  const summary = await cleanupExpired(openTables(config.data), now);
  log.info(
    `Cleanup finished: ${summary.transactions} sign-in transactions, ${summary.bootstraps} device bootstraps, `
    + `${summary.invitations} invitation rows, ${summary.rateLimits} rate limits, ${summary.failures} failed.`
  );
  if (summary.failures) throw new Error(`Cleanup left ${summary.failures} rows for the next run.`);
}
