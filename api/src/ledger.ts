import { createHash } from "node:crypto";
import { odata, type TableClient } from "@azure/data-tables";
import { validateEntry, type Mutation, type MutationResult, type VersionedRecord, type SyncPage } from "../../shared/model";
import { validateTodo } from "../../shared/todo";
import { HttpError } from "./config";
import { optionalEntity, jsonEntity, statusCode, type StoredJson, type Sequence, type Applied } from "./storage";

const fingerprint = <T extends VersionedRecord>(mutation: Mutation<T>) => {
  const { updatedAt: _timestamp, ...entry } = mutation.entry;
  return createHash("sha256").update(JSON.stringify({ expectedRevision: mutation.expectedRevision, entry })).digest("hex");
};

interface HouseholdUsage {
  day: string;
  dailyChanges: number;
  activeExpenses: number;
  activeTodos: number;
}

const dailyChangeLimit = 5_000;
const dailyChangeLimitMessage = "Household daily change limit reached. Try again after the limit resets.";
const usageDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const retryAfterUtcMidnight = (now: number) =>
  Math.max(1, Math.ceil((Date.parse(`${usageDay(now)}T23:59:59.999Z`) + 1 - now) / 1000));

export function createLedger<T extends VersionedRecord>(validate: (value: unknown) => T, prefix = "") {
  const changeKey = (sequence: number) => `${prefix}c-${String(sequence).padStart(16, "0")}`;
  const sequenceKey = `${prefix}sequence`;
  const countField = prefix ? "activeTodos" : "activeExpenses";
  const activeLimit = prefix ? 2_000 : 20_000;
  const activeLimitMessage = prefix
    ? "Household to-do limit reached. Delete a to-do before adding another."
    : "Household expense limit reached. Delete an expense before adding another.";

  async function householdUsage(table: TableClient, household: string, now: number) {
    let usage = await optionalEntity<HouseholdUsage>(table, household, "usage");
    if (usage) return usage;

    let activeExpenses = 0, activeTodos = 0;
    for (const [rowPrefix, upperPrefix, validateRecord] of [
      ["e-", "f-", validateEntry],
      ["todo-e-", "todo-f-", validateTodo]
    ] as const) {
      for await (const entity of table.listEntities<StoredJson>({
        queryOptions: { filter: odata`PartitionKey eq ${household} and RowKey ge ${rowPrefix} and RowKey lt ${upperPrefix}` }
      })) {
        if (!validateRecord(JSON.parse(entity.json)).deleted) {
          if (rowPrefix === "e-") activeExpenses++;
          else activeTodos++;
        }
      }
    }
    try {
      await table.createEntity({
        partitionKey: household,
        rowKey: "usage",
        day: usageDay(now),
        dailyChanges: 0,
        activeExpenses,
        activeTodos
      });
    } catch (error) {
      if (statusCode(error) !== 409) throw error;
    }
    usage = await optionalEntity<HouseholdUsage>(table, household, "usage");
    if (!usage) throw new Error("Household usage metadata could not be initialized.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(usage.day)
      || !Number.isSafeInteger(usage.dailyChanges) || usage.dailyChanges < 0
      || !Number.isSafeInteger(usage.activeExpenses) || usage.activeExpenses < 0
      || !Number.isSafeInteger(usage.activeTodos) || usage.activeTodos < 0) {
      throw new Error("Household usage metadata is invalid.");
    }
    return usage;
  }

  async function current(table: TableClient, household: string, id: string): Promise<T | null> {
    const entity = await optionalEntity<StoredJson>(table, household, `${prefix}e-${id}`);
    return entity ? validate(JSON.parse(entity.json)) : null;
  }

  async function applyMutation(table: TableClient, household: string, mutation: Mutation<T>): Promise<MutationResult<T>> {
    const requestFingerprint = fingerprint(mutation);
    for (let attempt = 0; attempt < 8; attempt++) {
      const applied = await optionalEntity<Applied>(table, household, `${prefix}o-${mutation.id}`);
      if (applied) {
        const entry = await current(table, household, mutation.entry.id);
        if (applied.fingerprint !== requestFingerprint || applied.entryId !== mutation.entry.id) {
          return { id: mutation.id, status: "conflict", entry };
        }
        if (!entry) throw new Error("Acknowledged entry is missing.");
        return { id: mutation.id, status: "ok", entry };
      }
      let meta = await optionalEntity<Sequence>(table, household, sequenceKey);
      if (!meta) {
        try { await table.createEntity({ partitionKey: household, rowKey: sequenceKey, sequence: 0 }); }
        catch (error) { if (statusCode(error) !== 409) throw error; }
        meta = await table.getEntity<Sequence>(household, sequenceKey);
      }
      const previous = await current(table, household, mutation.entry.id);
      if ((previous?.revision ?? 0) !== mutation.expectedRevision) {
        const receipt = await optionalEntity<Applied>(table, household, `${prefix}o-${mutation.id}`);
        if (receipt?.fingerprint === requestFingerprint && receipt.entryId === mutation.entry.id && previous) {
          return { id: mutation.id, status: "ok", entry: previous };
        }
        return { id: mutation.id, status: "conflict", entry: previous };
      }
      const now = Date.now();
      const usage = await householdUsage(table, household, now);
      const day = usageDay(now);
      const dailyChanges = usage.day === day ? usage.dailyChanges : 0;
      if (dailyChanges >= dailyChangeLimit) {
        throw new HttpError(429, dailyChangeLimitMessage, retryAfterUtcMidnight(now));
      }
      const wasActive = !!previous && !previous.deleted;
      const willBeActive = !mutation.entry.deleted;
      const activeCount = usage[countField] + Number(willBeActive) - Number(wasActive);
      if (willBeActive && !wasActive && activeCount > activeLimit) {
        throw new HttpError(429, activeLimitMessage, 60 * 60);
      }
      const sequence = meta.sequence + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("Ledger sequence limit reached.");
      const entry = { ...mutation.entry, revision: mutation.expectedRevision + 1, updatedAt: new Date().toISOString() };
      try {
        // The sequence CAS serializes writes; the log, receipt and entry commit atomically.
        await table.submitTransaction([
          ["update", { partitionKey: household, rowKey: sequenceKey, sequence }, "Replace", { etag: meta.etag }],
          previous
            ? ["upsert", jsonEntity(household, `${prefix}e-${entry.id}`, entry), "Replace"]
            : ["create", jsonEntity(household, `${prefix}e-${entry.id}`, entry)],
          ["create", jsonEntity(household, changeKey(sequence), entry)],
          ["create", { partitionKey: household, rowKey: `${prefix}o-${mutation.id}`, fingerprint: requestFingerprint, entryId: entry.id }],
          ["update", {
            partitionKey: household,
            rowKey: "usage",
            day,
            dailyChanges: dailyChanges + 1,
            activeExpenses: countField === "activeExpenses" ? activeCount : usage.activeExpenses,
            activeTodos: countField === "activeTodos" ? activeCount : usage.activeTodos
          }, "Replace", { etag: usage.etag }]
        ]);
        return { id: mutation.id, status: "ok", entry };
      } catch (error) {
        if (statusCode(error) !== 409 && statusCode(error) !== 412) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw new HttpError(503, "The ledger is busy. Your changes remain saved locally; retry shortly.");
  }

  async function readChanges(table: TableClient, household: string, since: number): Promise<SyncPage<T>> {
    const meta = await optionalEntity<Sequence>(table, household, sequenceKey);
    const head = meta?.sequence ?? 0;
    if (since > head) throw new HttpError(409, "The server history is older than this device. Restore the backend before syncing.");
    const entries: T[] = [];
    let cursor = since;
    if (since === head) return { entries, cursor, more: false };
    const lower = changeKey(since), upper = changeKey(head);
    for await (const entity of table.listEntities<StoredJson>({
      queryOptions: { filter: odata`PartitionKey eq ${household} and RowKey gt ${lower} and RowKey le ${upper}` }
    })) {
      const next = Number(entity.rowKey!.slice(prefix.length + 2));
      if (next !== cursor + 1) throw new Error("Ledger change log has a gap.");
      entries.push(validate(JSON.parse(entity.json)));
      cursor = next;
      if (entries.length === 500) break;
    }
    if (!entries.length) throw new Error("Ledger change log is incomplete.");
    return { entries, cursor, more: cursor < head };
  }

  return { applyMutation, readChanges };
}

export const expenseLedger = createLedger(validateEntry);
export const todoLedger = createLedger(validateTodo, "todo-");
export const { applyMutation, readChanges } = expenseLedger;
