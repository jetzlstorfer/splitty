type Row = Record<string, unknown> & { etag: string; rowKey?: string };
type Key = { partitionKey: string; rowKey: string };
type Action = ["delete", Key] | ["update", Key & Record<string, unknown>, "Merge", { etag: string }];

// Both separately deployed Functions apps supply their own Azure Table client.
interface DeletionTable {
  listEntities(options: { queryOptions: { filter: string; select: string[] } }): AsyncIterable<Row>;
  submitTransaction(actions: Action[]): Promise<unknown>;
  deleteEntity(partitionKey: string, rowKey: string): Promise<unknown>;
}

const stableId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

async function finishHousehold(
  table: DeletionTable, householdId: string, userId: string, deletedAt: number, purgeAfter: number
): Promise<number> {
  const partitionKey = `h-${householdId}`;
  const rows = new Map<string, Row>();
  for await (const row of table.listEntities({ queryOptions: {
    filter: `PartitionKey eq '${partitionKey}' and RowKey ge 'household' and RowKey lt 'n'`,
    select: ["RowKey", "userId", "active", "member", "deletedAt", "id"]
  } })) {
    if (row.rowKey) rows.set(row.rowKey, row);
  }
  const membershipKey = `m-${userId}`;
  const membership = rows.get(membershipKey);
  // A stale index (including a retry after this transaction committed) owns no slot.
  if (!membership) return 0;
  if (membership.userId !== userId || (membership.member !== "a" && membership.member !== "b")) {
    throw new Error("Unexpected account membership during deletion.");
  }
  const actions: Action[] = [["delete", { partitionKey, rowKey: membershipKey }]];
  if (membership.active !== true) {
    await table.submitTransaction(actions);
    return 1;
  }
  const others = [...rows.entries()].filter(([key, row]) =>
    key !== membershipKey && key.startsWith("m-") && row.active === true
  );
  const slot = membership.member;
  const slotVacant = !others.some(([, row]) => row.member === slot);
  for (const vacantSlot of others.length ? (slotVacant ? [slot] : []) : ["a", "b"]) {
    const rowKey = `invite-slot-${vacantSlot}`;
    const reservation = rows.get(rowKey);
    if (!reservation) continue;
    actions.push(["delete", { partitionKey, rowKey }]);
    const invitationKey = `i-${reservation.id}`;
    if (rows.has(invitationKey)) actions.push(["delete", { partitionKey, rowKey: invitationKey }]);
  }
  const deletedRows = actions.length;
  const household = rows.get("household");
  if (household && !household.deletedAt && slotVacant) {
    actions.push(["update", {
      partitionKey, rowKey: "household", [slot === "a" ? "nameA" : "nameB"]: "",
      ...(!others.length ? { deletedAt, purgeAfter } : {})
    }, "Merge", { etag: household.etag }]);
  }
  // The authoritative row disappears only when its name, invitations and empty-household marker are settled.
  await table.submitTransaction(actions);
  return deletedRows;
}

/** The account's existing index rows double as the worklist until each household transaction commits. */
export async function finishAccountMemberships(
  table: DeletionTable, userId: string, deletedAt: number, purgeAfter: number, include: unknown[]
): Promise<number> {
  if (!stableId(userId)) throw new Error("Unexpected account identifier during deletion.");
  const prefix = `m-${userId}.`;
  const households = new Map<string, string | undefined>();
  for (const id of include) if (stableId(id)) households.set(id, undefined);
  for await (const row of table.listEntities({ queryOptions: {
    filter: `PartitionKey eq 'users' and RowKey ge '${prefix}' and RowKey lt 'm-${userId}/'`,
    select: ["RowKey"]
  } })) {
    if (row.rowKey?.startsWith(prefix)) households.set(row.rowKey.slice(prefix.length), row.rowKey);
  }
  let deleted = 0;
  for (const [id, indexKey] of households) {
    if (stableId(id)) deleted += await finishHousehold(table, id, userId, deletedAt, purgeAfter);
    if (indexKey) {
      try { await table.deleteEntity("users", indexKey); deleted++; }
      catch (error) {
        if ((error as { statusCode?: number })?.statusCode !== 404) throw error;
      }
    }
  }
  return deleted;
}
