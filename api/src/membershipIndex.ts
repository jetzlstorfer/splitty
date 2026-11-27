import { odata, type TableClient } from "@azure/data-tables";
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
}

export async function addMembershipIndex(
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

export async function removeMembershipIndex(table: TableClient, userId: string, householdId: string): Promise<void> {
  try { await table.deleteEntity(userPartition, membershipIndexRow(userId, householdId)); }
  catch (error) { if (statusCode(error) !== 404) throw error; }
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
