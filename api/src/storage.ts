import { TableClient, type TableEntityResult } from "@azure/data-tables";
import type { Config } from "./config";

export function statusCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : undefined;
}

export async function optionalEntity<T extends object>(table: TableClient, partition: string, row: string): Promise<TableEntityResult<T> | null> {
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

let connected: { connection: string; promise: Promise<{ ledger: TableClient; auth: TableClient }> } | undefined;

export async function tables(config: Config): Promise<{ ledger: TableClient; auth: TableClient }> {
  if (!connected || connected.connection !== config.connection) {
    const promise = (async () => {
      const ledger = TableClient.fromConnectionString(config.connection, "SplittyLedger");
      const auth = TableClient.fromConnectionString(config.connection, "SplittyAuth");
      await Promise.all([ledger.createTable(), auth.createTable()]);
      return { ledger, auth };
    })();
    connected = { connection: config.connection, promise };
    void promise.catch(() => { connected = undefined; });
  }
  return connected.promise;
}
