import { createHash } from "node:crypto";
import { odata, type TableClient } from "@azure/data-tables";
import { validateEntry, type Mutation, type MutationResult, type Entry, type SyncPage } from "../../shared/model";
import { HttpError } from "./config";
import { optionalEntity, jsonEntity, statusCode, type StoredJson, type Sequence, type Applied } from "./storage";

const changeKey = (sequence: number) => `c-${String(sequence).padStart(16, "0")}`;
const fingerprint = (mutation: Mutation) => {
  const { updatedAt: _timestamp, ...entry } = mutation.entry;
  return createHash("sha256").update(JSON.stringify({ expectedRevision: mutation.expectedRevision, entry })).digest("hex");
};

async function current(table: TableClient, household: string, id: string): Promise<Entry | null> {
  const entity = await optionalEntity<StoredJson>(table, household, `e-${id}`);
  return entity ? validateEntry(JSON.parse(entity.json)) : null;
}

export async function applyMutation(table: TableClient, household: string, mutation: Mutation): Promise<MutationResult> {
  const requestFingerprint = fingerprint(mutation);
  for (let attempt = 0; attempt < 8; attempt++) {
    const applied = await optionalEntity<Applied>(table, household, `o-${mutation.id}`);
    if (applied) {
      const entry = await current(table, household, mutation.entry.id);
      if (applied.fingerprint !== requestFingerprint || applied.entryId !== mutation.entry.id) {
        return { id: mutation.id, status: "conflict", entry };
      }
      if (!entry) throw new Error("Acknowledged entry is missing.");
      return { id: mutation.id, status: "ok", entry };
    }
    let meta = await optionalEntity<Sequence>(table, household, "sequence");
    if (!meta) {
      try { await table.createEntity({ partitionKey: household, rowKey: "sequence", sequence: 0 }); }
      catch (error) { if (statusCode(error) !== 409) throw error; }
      meta = await table.getEntity<Sequence>(household, "sequence");
    }
    const previous = await current(table, household, mutation.entry.id);
    if ((previous?.revision ?? 0) !== mutation.expectedRevision) {
      const receipt = await optionalEntity<Applied>(table, household, `o-${mutation.id}`);
      if (receipt?.fingerprint === requestFingerprint && receipt.entryId === mutation.entry.id && previous) {
        return { id: mutation.id, status: "ok", entry: previous };
      }
      return { id: mutation.id, status: "conflict", entry: previous };
    }
    const sequence = meta.sequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("Ledger sequence limit reached.");
    const entry: Entry = { ...mutation.entry, revision: mutation.expectedRevision + 1, updatedAt: new Date().toISOString() };
    try {
      // The sequence CAS serializes writes; the log, receipt and entry commit atomically.
      await table.submitTransaction([
        ["update", { partitionKey: household, rowKey: "sequence", sequence }, "Replace", { etag: meta.etag }],
        previous
          ? ["upsert", jsonEntity(household, `e-${entry.id}`, entry), "Replace"]
          : ["create", jsonEntity(household, `e-${entry.id}`, entry)],
        ["create", jsonEntity(household, changeKey(sequence), entry)],
        ["create", { partitionKey: household, rowKey: `o-${mutation.id}`, fingerprint: requestFingerprint, entryId: entry.id }]
      ]);
      return { id: mutation.id, status: "ok", entry };
    } catch (error) {
      if (statusCode(error) !== 409 && statusCode(error) !== 412) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw new HttpError(503, "The ledger is busy. Your changes remain saved locally; retry shortly.");
}

export async function readChanges(table: TableClient, household: string, since: number): Promise<SyncPage> {
  const meta = await optionalEntity<Sequence>(table, household, "sequence");
  const head = meta?.sequence ?? 0;
  if (since > head) throw new HttpError(409, "The server history is older than this device. Restore the backend before syncing.");
  const entries: Entry[] = [];
  let cursor = since;
  if (since === head) return { entries, cursor, more: false };
  const lower = changeKey(since), upper = changeKey(head);
  for await (const entity of table.listEntities<StoredJson>({
    queryOptions: { filter: odata`PartitionKey eq ${household} and RowKey gt ${lower} and RowKey le ${upper}` }
  })) {
    const next = Number(entity.rowKey!.slice(2));
    if (next !== cursor + 1) throw new Error("Ledger change log has a gap.");
    entries.push(validateEntry(JSON.parse(entity.json)));
    cursor = next;
    if (entries.length === 500) break;
  }
  if (!entries.length) throw new Error("Ledger change log is incomplete.");
  return { entries, cursor, more: cursor < head };
}
