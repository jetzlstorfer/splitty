import { odata, type TableClient } from "@azure/data-tables";
import { Readable, pipeline } from "node:stream";
import { createGzip } from "node:zlib";
import { entities } from "./common";
import type { DataTables } from "./tables";

/** Stores a stream under a name without replacing an existing blob. */
export type Upload = (blobName: string, data: Readable) => Promise<"created" | "exists">;

export interface BackupManifest {
  date: string;
  createdAt: string;
  tables: Record<string, { blob: string; rows: number | null }>;
}

export interface BackupSummary {
  date: string;
  tables: Record<string, number | null>;
}

// Sessions, legacy sessions, rate limits and short-lived sign-in state are credentials or
// transient: they are neither needed nor safe to keep in a backup.
const authFilters = [
  odata`PartitionKey eq ${"users"}`,
  odata`PartitionKey ge ${"h-"} and PartitionKey lt ${"h."}`
];

// Table entities are flat. Buffer has its own toJSON, so binary values are converted before
// stringifying rather than in a replacer, which would only see the already-converted form.
function serializable(entity: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entity)) {
    if (name === "etag") continue;
    if (typeof value === "bigint") row[name] = value.toString();
    else if (value instanceof Uint8Array) row[name] = { $base64: Buffer.from(value).toString("base64") };
    else row[name] = value;
  }
  return row;
}

async function* lines(table: TableClient, filters: Array<string | undefined>, counter: { rows: number }) {
  for (const filter of filters) {
    for await (const entity of entities(table, filter ? { filter } : {})) {
      counter.rows += 1;
      yield `${JSON.stringify(serializable(entity))}\n`;
    }
  }
}

function gzipped(source: AsyncIterable<string>): Readable {
  const gzip = createGzip();
  // pipeline destroys the gzip stream on a source error, so the upload fails instead of committing a truncated blob.
  return pipeline(Readable.from(source), gzip, () => undefined);
}

/** Writes one gzip NDJSON blob per table and a manifest last, so a manifest means a complete backup. */
export async function backupTables(tables: DataTables, upload: Upload, now: Date): Promise<BackupSummary> {
  const date = now.toISOString().slice(0, 10);
  const manifest: BackupManifest = { date, createdAt: now.toISOString(), tables: {} };
  const summary: BackupSummary = { date, tables: {} };

  for (const [table, filters] of [[tables.auth, authFilters], [tables.ledger, [undefined]]] as const) {
    const blob = `${date}/${table.tableName}.ndjson.gz`;
    const counter = { rows: 0 };
    const outcome = await upload(blob, gzipped(lines(table, [...filters], counter)));
    const rows = outcome === "created" ? counter.rows : null;
    manifest.tables[table.tableName] = { blob, rows };
    summary.tables[table.tableName] = rows;
  }

  await upload(`${date}/manifest.json`, Readable.from([`${JSON.stringify(manifest, null, 2)}\n`]));
  return summary;
}
