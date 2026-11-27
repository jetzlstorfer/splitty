import { randomUUID } from "node:crypto";
import { odata, type TableClient, type TransactionAction } from "@azure/data-tables";
import type { Member } from "../../shared/model";
import { HttpError } from "./config";
import { optionalEntity, statusCode } from "./storage";

/** Caps how many households one account can join or create. */
export const maxHouseholdsPerUser = 10;

const userPartition = "users";
const householdPartition = (householdId: string) => `h-${householdId}`;
const isStableId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

/**
 * Index rows let an account find all of its households without scanning every household partition.
 * The household's `m-<userId>` row stays authoritative; index rows are only candidates.
 */
export const membershipIndexRow = (userId: string, householdId: string) => `m-${userId}.${householdId}`;

export interface HouseholdMembership {
  householdId: string;
  member: Member;
  nameA: string;
  nameB: string;
  joinedAt: number;
}

interface IndexEntity { userId?: unknown; householdId?: unknown; joinedAt?: unknown }
interface MembershipEntity { userId: string; member: Member; active: boolean }
interface HouseholdEntity { nameA?: unknown; nameB?: unknown; deletedAt?: number }
interface UserEntity {
  userId: string;
  householdId?: string;
  deletionRequestedAt?: number;
  legacyClaimed?: boolean;
  legacyHouseholdId?: string;
  pendingMembership?: string;
}

type Addition = { householdId: string; member: Member; invitationId?: string; nameA?: string };
type PendingAddition = Addition & { membershipId: string };
type Outcome = "added" | "expired" | "duplicate";

const limitError = () => new HttpError(409, "This account already belongs to the maximum number of households.");
const busy = () => new HttpError(503, "Request limits are temporarily unavailable. Retry shortly.", 1);
const contention = (error: unknown) => [404, 409, 412].includes(statusCode(error) ?? 0);

/** An immutable receipt fences delayed helpers even after a successful member has left. */
async function applyAddition(table: TableClient, userId: string, pending: PendingAddition): Promise<Outcome> {
  const { householdId, member, membershipId, invitationId, nameA } = pending;
  const partitionKey = householdPartition(householdId);
  const receipt = { partitionKey, rowKey: `add-${membershipId}` };
  for (let attempt = 0; attempt < 8; attempt++) {
    const settled = await optionalEntity<{ outcome: Outcome }>(table, partitionKey, receipt.rowKey);
    if (settled) return settled.outcome;
    const membership = await optionalEntity<MembershipEntity>(table, partitionKey, `m-${userId}`);
    let outcome: Outcome = membership ? "duplicate" : "added";
    const actions: TransactionAction[] = [];
    if (invitationId) {
      const household = await optionalEntity<HouseholdEntity>(table, partitionKey, "household");
      const invite = await optionalEntity<{ slot: Member; expiresAt: number }>(table, partitionKey, `i-${invitationId}`);
      const slot = await optionalEntity<{ id: string; expiresAt: number }>(table, partitionKey, `invite-slot-${member}`);
      if (!household || household.deletedAt || invite?.slot !== member || invite.expiresAt <= Date.now()
        || slot?.id !== invitationId || slot.expiresAt <= Date.now()) outcome = "expired";
      else if (outcome === "added") {
        actions.push(["update", { partitionKey, rowKey: "household" }, "Merge", { etag: household.etag }],
          ["delete", { partitionKey, rowKey: `i-${invitationId}` }],
          ["delete", { partitionKey, rowKey: `invite-slot-${member}` }]);
      }
    } else if (nameA !== undefined) {
      actions.push(["create", { partitionKey, rowKey: "household", nameA, nameB: "" }]);
    }
    if (outcome === "added") {
      actions.push(["create", { partitionKey, rowKey: `m-${userId}`, userId, member, active: true, membershipId }]);
    }
    try {
      await table.submitTransaction([
        ["create", { ...receipt, outcome }], ...(outcome === "added" ? actions : [])
      ]);
      return outcome;
    } catch (error) {
      if (!contention(error)) throw error;
    }
  }
  throw busy();
}

async function finishAddition(table: TableClient, userId: string, serialized: string) {
  const pending: PendingAddition = JSON.parse(serialized);
  const outcome = await applyAddition(table, userId, pending);
  const userKey = { partitionKey: userPartition, rowKey: `u-${userId}` };
  for (let attempt = 0; attempt < 8; attempt++) {
    const user = await optionalEntity<UserEntity>(table, userPartition, userKey.rowKey);
    if (user?.pendingMembership !== serialized) return outcome;
    const actions: TransactionAction[] = [["update", { ...userKey, pendingMembership: "" }, "Merge", { etag: user.etag }]];
    const index = { partitionKey: userPartition, rowKey: membershipIndexRow(userId, pending.householdId) };
    if (outcome === "expired" && await optionalEntity(table, userPartition, index.rowKey)) {
      actions.push(["delete", index]);
    }
    try { await table.submitTransaction(actions); return outcome; }
    catch (error) { if (!contention(error)) throw error; }
  }
  throw busy();
}

export async function recoverMembershipAddition(table: TableClient, userId: string): Promise<void> {
  const user = await optionalEntity<UserEntity>(table, userPartition, `u-${userId}`);
  if (user?.pendingMembership) await finishAddition(table, userId, user.pendingMembership);
}

/** Reserve against the ETag read before counting. Other writers finish interrupted additions before recounting. */
export async function addHouseholdMembership(
  table: TableClient, userId: string, addition: Addition, include?: string
): Promise<void> {
  if (!isStableId(userId) || !isStableId(addition.householdId)) throw new HttpError(400, "Invalid household membership.");
  const rowKey = `u-${userId}`;
  const joinedAt = Date.now();
  const pending = JSON.stringify({ ...addition, membershipId: randomUUID() } satisfies PendingAddition);
  for (let attempt = 0; attempt < 8; attempt++) {
    const user = await optionalEntity<UserEntity>(table, userPartition, rowKey);
    if (!user || user.userId !== userId) throw new HttpError(404, "Account not found.");
    if (user.deletionRequestedAt) throw new HttpError(410, "This account is scheduled for deletion.");
    if (user.pendingMembership) { await finishAddition(table, userId, user.pendingMembership); continue; }
    const memberships = await listUserMemberships(table, userId, [include, user.householdId, addition.householdId]);
    if (memberships.some((m) => m.householdId === addition.householdId)) {
      if (!addition.invitationId) return;
      throw new HttpError(409, "This account is already a member of this household.");
    }
    if (memberships.length >= maxHouseholdsPerUser) throw limitError();
    try {
      await table.submitTransaction([
        ["update", { partitionKey: userPartition, rowKey, pendingMembership: pending }, "Merge", { etag: user.etag }],
        ["upsert", {
          partitionKey: userPartition, rowKey: membershipIndexRow(userId, addition.householdId),
          userId, householdId: addition.householdId, joinedAt
        }, "Replace"]
      ]);
    } catch (error) {
      if (!contention(error)) throw error;
      continue;
    }
    const outcome = await finishAddition(table, userId, pending);
    if (outcome === "expired") throw new HttpError(410, "This invitation has expired or was already used.");
    if (outcome === "duplicate") throw new HttpError(409, "This account is already a member of this household.");
    return;
  }
  throw busy();
}

async function addMembershipIndex(
  table: TableClient, userId: string, householdId: string, joinedAt = Date.now()
): Promise<void> {
  try {
    await table.createEntity({
      partitionKey: userPartition, rowKey: membershipIndexRow(userId, householdId), userId, householdId, joinedAt
    });
  } catch (error) {
    // Keep the original join time when the row already exists.
    if (statusCode(error) !== 409) throw error;
  }
}

export async function removeIndexedMembership(table: TableClient, userId: string, householdId: string): Promise<void> {
  // A delayed removal must not delete the index of a subsequent admission to the same household.
  const index = await optionalEntity<IndexEntity>(table, userPartition, membershipIndexRow(userId, householdId));
  try { await table.deleteEntity(householdPartition(householdId), `m-${userId}`); }
  catch (error) { if (statusCode(error) !== 404) throw error; }
  if (index) {
    try { await table.deleteEntity(userPartition, membershipIndexRow(userId, householdId), { etag: index.etag }); }
    catch (error) { if (statusCode(error) !== 404 && statusCode(error) !== 412) throw error; }
  }
}

/** Returns the account's active membership in a household that is not scheduled for deletion. */
export async function verifiedMembership(
  table: TableClient, userId: string, householdId: string, joinedAt = 0
): Promise<HouseholdMembership | null> {
  if (!isStableId(userId) || !isStableId(householdId)) return null;
  const household = await optionalEntity<HouseholdEntity>(table, householdPartition(householdId), "household");
  if (household?.deletedAt) return null;
  const membership = await optionalEntity<MembershipEntity>(table, householdPartition(householdId), `m-${userId}`);
  if (!membership || membership.active !== true || membership.userId !== userId
    || (membership.member !== "a" && membership.member !== "b")) {
    return null;
  }
  return {
    householdId,
    member: membership.member,
    nameA: typeof household?.nameA === "string" ? household.nameA : "",
    nameB: typeof household?.nameB === "string" ? household.nameB : "",
    joinedAt
  };
}

/**
 * Lists the account's verified households in join order. `include` adds households that may predate
 * the index, such as the account's default household; verified ones are indexed for later lookups.
 */
export async function listUserMemberships(
  table: TableClient, userId: string, include: Array<string | undefined> = []
): Promise<HouseholdMembership[]> {
  if (!isStableId(userId)) return [];
  const candidates = new Map<string, number | undefined>();
  for await (const row of table.listEntities<IndexEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${userPartition} and RowKey ge ${`m-${userId}.`} and RowKey lt ${`m-${userId}/`}`
    }
  })) {
    if (row.userId === userId && isStableId(row.householdId)) {
      candidates.set(row.householdId, typeof row.joinedAt === "number" ? row.joinedAt : 0);
    }
  }
  for (const householdId of include) {
    if (isStableId(householdId) && !candidates.has(householdId)) candidates.set(householdId, undefined);
  }
  const results: HouseholdMembership[] = [];
  for (const [householdId, joinedAt] of candidates) {
    const membership = await verifiedMembership(table, userId, householdId, joinedAt ?? 0);
    if (!membership) continue;
    if (joinedAt === undefined) await addMembershipIndex(table, userId, householdId, 0);
    results.push(membership);
  }
  return results.sort((a, b) => a.joinedAt - b.joinedAt || a.householdId.localeCompare(b.householdId));
}

/** Points the account's next sign-in at `target`, or clears it when the account has no household left. */
export async function setDefaultHousehold(
  table: TableClient, userId: string, target: Pick<HouseholdMembership, "householdId" | "member"> | null
): Promise<void> {
  const user = await optionalEntity<UserEntity>(table, userPartition, `u-${userId}`);
  if (!user || user.userId !== userId) throw new HttpError(404, "Account not found.");
  if (user.deletionRequestedAt) throw new HttpError(410, "This account is scheduled for deletion.");
  // Legacy local history belongs to the household the account claimed, not the next default.
  const keepLegacyHousehold = user.legacyClaimed === true && !user.legacyHouseholdId
    && !!user.householdId && user.householdId !== target?.householdId;
  await table.updateEntity({
    partitionKey: userPartition,
    rowKey: `u-${userId}`,
    householdId: target?.householdId ?? "",
    member: target?.member ?? "",
    membershipInitialized: !!target,
    ...(keepLegacyHousehold ? { legacyHouseholdId: user.householdId } : {})
  }, "Merge", { etag: user.etag });
}
