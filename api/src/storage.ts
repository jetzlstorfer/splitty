import { TableClient, type TableEntityResult } from "@azure/data-tables";
import { ClientSecretCredential } from "@azure/identity";
import type { Config } from "./config";

export function statusCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : undefined;
}

export async function optionalEntity<T extends object>(table: Pick<TableClient, "getEntity">, partition: string, row: string): Promise<TableEntityResult<T> | null> {
  try { return await table.getEntity<T>(partition, row); }
  catch (error) {
    if (statusCode(error) === 404) return null;
    throw error;
  }
}

export interface StoredJson { json: string }
export interface Sequence { sequence: number }
export interface Applied { fingerprint: string; entryId: string }

export function jsonEntity(partitionKey: string, rowKey: string, value: unknown) {
  return { partitionKey, rowKey, json: JSON.stringify(value) };
}

let connected: {
  storage: Config["storage"];
  local: boolean;
  promise: Promise<{ ledger: TableClient; auth: TableClient }>;
} | undefined;

function sameStorage(a: Config["storage"], b: Config["storage"]): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "connectionString" && b.kind === "connectionString") return a.connection === b.connection;
  return a.kind === "rbac" && b.kind === "rbac"
    && a.accountName === b.accountName
    && a.tenantId === b.tenantId
    && a.clientId === b.clientId
    && a.clientSecret === b.clientSecret;
}

export async function tables(config: Config): Promise<{ ledger: TableClient; auth: TableClient }> {
  if (!connected || connected.local !== config.local || !sameStorage(connected.storage, config.storage)) {
    const promise = (async () => {
      let ledger: TableClient;
      let auth: TableClient;
      if (config.storage.kind === "connectionString") {
        const options = { allowInsecureConnection: config.local };
        ledger = TableClient.fromConnectionString(config.storage.connection, "SplittyLedger", options);
        auth = TableClient.fromConnectionString(config.storage.connection, "SplittyAuth", options);
      } else {
        const endpoint = `https://${config.storage.accountName}.table.core.windows.net`;
        const credential = new ClientSecretCredential(
          config.storage.tenantId, config.storage.clientId, config.storage.clientSecret
        );
        ledger = new TableClient(endpoint, "SplittyLedger", credential);
        auth = new TableClient(endpoint, "SplittyAuth", credential);
      }
      await Promise.all([ledger.createTable(), auth.createTable()]);
      return { ledger, auth };
    })();
    connected = { storage: config.storage, local: config.local, promise };
    void promise.catch(() => { connected = undefined; });
  }
  return connected.promise;
}
