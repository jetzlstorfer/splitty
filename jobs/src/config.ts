export type StorageSource =
  | { kind: "connectionString"; connection: string }
  | { kind: "identity"; accountName: string; suffix: string };

export interface JobsConfig {
  data: StorageSource;
  backup: StorageSource;
  backupContainer: string;
}

function source(env: NodeJS.ProcessEnv, prefix: "TABLE" | "BACKUP"): StorageSource {
  const connection = env[`${prefix}_STORAGE_CONNECTION_STRING`]?.trim();
  if (connection) return { kind: "connectionString", connection };
  const accountName = env[`${prefix}_STORAGE_ACCOUNT_NAME`]?.trim();
  if (!accountName) {
    throw new Error(`Set ${prefix}_STORAGE_ACCOUNT_NAME (or ${prefix}_STORAGE_CONNECTION_STRING for local emulation).`);
  }
  return { kind: "identity", accountName, suffix: env.STORAGE_ENDPOINT_SUFFIX?.trim() || "core.windows.net" };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  return {
    data: source(env, "TABLE"),
    backup: source(env, "BACKUP"),
    backupContainer: env.BACKUP_CONTAINER_NAME?.trim() || "splitty-backups"
  };
}
