import { randomBytes } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import { finishAccountMemberships } from "../../shared/accountDeletion";
import { defaultInsuranceTodoSetting, type InsuranceTodoSetting, type Member } from "../../shared/model";
import type { AuthContext } from "./auth";
import { HttpError, type Config } from "./config";
import { clearInvitationSlot, consumeInvitation, inspectInvitation } from "./invitations";
import {
  addHouseholdMembership, listUserMemberships, maxHouseholdsPerUser, recoverMembershipAddition,
  removeIndexedMembership, setDefaultHousehold, verifiedMembership,
  type HouseholdMembership
} from "./membershipIndex";
import { consumeRateLimit } from "./rateLimit";
import { optionalEntity, statusCode } from "./storage";

const householdPartition = (householdId: string) => `h-${householdId}`;
const userPartition = "users";
const deletionGraceMs = 30 * 24 * 60 * 60 * 1000;

export async function insuranceTodoSetting(
  ledger: TableClient, household: string, change?: InsuranceTodoSetting
): Promise<InsuranceTodoSetting> {
  const rowKey = "insurance-todo-setting";
  const read = () => optionalEntity<InsuranceTodoSetting>(ledger, household, rowKey);
  const stored = await read();
  const { enabled, revision } = stored ?? defaultInsuranceTodoSetting;
  if (!change || change.revision !== revision || change.enabled === enabled) return { enabled, revision };
  const next = { enabled: change.enabled, revision: revision + 1 };
  const entity = { partitionKey: household, rowKey, ...next };
  try {
    if (stored) await ledger.updateEntity(entity, "Replace", { etag: stored.etag });
    else await ledger.createEntity(entity);
    return next;
  } catch (error) {
    if (statusCode(error) !== 409 && statusCode(error) !== 412) throw error;
    const current = await ledger.getEntity<InsuranceTodoSetting>(household, rowKey);
    return { enabled: current.enabled, revision: current.revision };
  }
}

interface HouseholdEntity {
  nameA: string;
  nameB: string;
  deletedAt?: number;
  purgeAfter?: number;
}

interface UserEntity {
  userId: string;
  householdId?: string;
  member?: Member;
  membershipInitialized?: boolean;
  deletionRequestedAt?: number;
  purgeAfter?: number;
  name?: string;
}

interface MembershipEntity {
  userId: string;
  member: Member;
  active: boolean;
}

async function activeHousehold(table: TableClient, householdId: string) {
  const household = await optionalEntity<HouseholdEntity>(table, householdPartition(householdId), "household");
  if (!household || household.deletedAt) throw new HttpError(410, "This household is scheduled for deletion.");
  return household;
}

/** Moves the account's default household to another membership when it loses the current one. */
async function detachUser(table: TableClient, userId: string, householdId: string, member: Member): Promise<void> {
  const user = await optionalEntity<UserEntity>(table, userPartition, `u-${userId}`);
  if (!user || user.userId !== userId) throw new HttpError(404, "Household member not found.");
  if (user.householdId !== householdId || user.member !== member || user.deletionRequestedAt) return;
  const next = (await listUserMemberships(table, userId))
    .find((membership) => membership.householdId !== householdId) ?? null;
  await setDefaultHousehold(table, userId, next);
}

async function membershipForSlot(
  table: TableClient, householdId: string, member: Member
): Promise<{ userId: string } | null> {
  const partitionKey = householdPartition(householdId);
  for await (const entity of table.listEntities<MembershipEntity>({
    queryOptions: { filter: `PartitionKey eq '${partitionKey}' and member eq '${member}' and active eq true` }
  })) {
    if (typeof entity.rowKey === "string" && entity.rowKey.startsWith("m-")
      && typeof entity.userId === "string") return { userId: entity.userId };
  }
  return null;
}

/** Whether the other member slot has an active membership, as opposed to a name or a pending invitation. */
export async function otherMemberJoined(
  table: TableClient, context: Pick<AuthContext, "householdId" | "member">
): Promise<boolean> {
  return !!await membershipForSlot(table, context.householdId, context.member === "a" ? "b" : "a");
}

async function memberships(table: TableClient, householdId: string): Promise<Array<{ userId: string; member: Member }>> {
  const partitionKey = householdPartition(householdId);
  const results: Array<{ userId: string; member: Member }> = [];
  for await (const entity of table.listEntities<MembershipEntity>({
    queryOptions: { filter: `PartitionKey eq '${partitionKey}' and active eq true` }
  })) {
    if (typeof entity.rowKey === "string" && entity.rowKey.startsWith("m-")
      && typeof entity.userId === "string" && (entity.member === "a" || entity.member === "b")) {
      results.push({ userId: entity.userId, member: entity.member });
    }
  }
  return results;
}

async function scheduleEmptyHouseholdDeletion(table: TableClient, householdId: string): Promise<void> {
  if ((await memberships(table, householdId)).length) return;
  const household = await optionalEntity<HouseholdEntity>(table, householdPartition(householdId), "household");
  if (!household || household.deletedAt) return;
  const deletedAt = Date.now();
  await table.updateEntity({
    partitionKey: householdPartition(householdId),
    rowKey: "household",
    deletedAt,
    purgeAfter: deletedAt + deletionGraceMs
  }, "Merge", { etag: household.etag });
  await clearInvitationSlot(table, householdId, "a");
  await clearInvitationSlot(table, householdId, "b");
}

export async function renameHouseholdMember(
  table: TableClient, context: AuthContext, slot: unknown, name: unknown
): Promise<void> {
  if ((slot !== "a" && slot !== "b") || typeof name !== "string" || name.trim().length > 60) {
    throw new HttpError(400, "Enter a member name of at most 60 characters.");
  }
  const household = await activeHousehold(table, context.householdId);
  await table.updateEntity({
    partitionKey: householdPartition(context.householdId),
    rowKey: "household",
    [slot === "a" ? "nameA" : "nameB"]: name.trim()
  }, "Merge", { etag: household.etag });
}

export async function leaveHousehold(table: TableClient, context: AuthContext): Promise<void> {
  const household = await activeHousehold(table, context.householdId);
  await detachUser(table, context.userId, context.householdId, context.member);
  await removeIndexedMembership(table, context.userId, context.householdId);
  await table.updateEntity({
    partitionKey: householdPartition(context.householdId),
    rowKey: "household",
    [context.member === "a" ? "nameA" : "nameB"]: ""
  }, "Merge", { etag: household.etag });
  await clearInvitationSlot(table, context.householdId, context.member);
  await scheduleEmptyHouseholdDeletion(table, context.householdId);
}

export async function removeOtherMember(table: TableClient, context: AuthContext): Promise<void> {
  await activeHousehold(table, context.householdId);
  const other: Member = context.member === "a" ? "b" : "a";
  const target = await membershipForSlot(table, context.householdId, other);
  if (!target) throw new HttpError(404, "The other household member is not present.");
  await detachUser(table, target.userId, context.householdId, other);
  await removeIndexedMembership(table, target.userId, context.householdId);
  const household = await activeHousehold(table, context.householdId);
  await table.updateEntity({
    partitionKey: householdPartition(context.householdId),
    rowKey: "household",
    [other === "a" ? "nameA" : "nameB"]: ""
  }, "Merge", { etag: household.etag });
  await clearInvitationSlot(table, context.householdId, other);
}

export async function deleteHousehold(table: TableClient, context: AuthContext): Promise<void> {
  const household = await activeHousehold(table, context.householdId);
  const now = Date.now();
  await table.updateEntity({
    partitionKey: householdPartition(context.householdId),
    rowKey: "household",
    deletedAt: now,
    purgeAfter: now + deletionGraceMs
  }, "Merge", { etag: household.etag });
  const members = await memberships(table, context.householdId);
  for (const member of members) {
    await detachUser(table, member.userId, context.householdId, member.member);
    await removeIndexedMembership(table, member.userId, context.householdId);
    await clearInvitationSlot(table, context.householdId, member.member);
  }
}

export async function deleteAccount(table: TableClient, context: AuthContext): Promise<void> {
  await activeHousehold(table, context.householdId);
  const readUser = async () => {
    const user = await optionalEntity<UserEntity & { pendingMembership?: string }>(table, userPartition, `u-${context.userId}`);
    if (!user || user.userId !== context.userId) throw new HttpError(404, "Account not found.");
    return user;
  };
  let user = await readUser();
  while (user.pendingMembership) {
    await recoverMembershipAddition(table, context.userId);
    user = await readUser();
  }
  const now = Date.now();
  await table.updateEntity({
    partitionKey: userPartition,
    rowKey: `u-${context.userId}`,
    deletionRequestedAt: now,
    purgeAfter: now + deletionGraceMs
  }, "Merge", { etag: user.etag });
  await finishAccountMemberships(table, context.userId, now, now + deletionGraceMs, [context.householdId, user.householdId]);
}

export interface HouseholdSummary {
  householdId: string;
  member: Member;
  nameA: string;
  nameB: string;
  current: boolean;
}

async function accountForMembership(table: TableClient, identity: AuthContext) {
  const user = await optionalEntity<UserEntity>(table, userPartition, `u-${identity.userId}`);
  if (!user || user.userId !== identity.userId) throw new HttpError(404, "Account not found.");
  return user;
}

async function accountMemberships(table: TableClient, identity: AuthContext) {
  const user = await accountForMembership(table, identity);
  return { user, memberships: await listUserMemberships(table, identity.userId, [identity.householdId, user.householdId]) };
}

function assertBelowHouseholdLimit(memberships: HouseholdMembership[]): void {
  if (memberships.length >= maxHouseholdsPerUser) {
    throw new HttpError(409, "This account already belongs to the maximum number of households.");
  }
}

export async function listHouseholds(
  table: TableClient, config: Pick<Config, "allowNewHouseholds">, identity: AuthContext
): Promise<{ households: HouseholdSummary[]; canCreate: boolean }> {
  const { memberships } = await accountMemberships(table, identity);
  return {
    households: memberships.map(({ householdId, member, nameA, nameB }) => ({
      householdId, member, nameA, nameB, current: householdId === identity.householdId
    })),
    canCreate: config.allowNewHouseholds && memberships.length < maxHouseholdsPerUser
  };
}

/** Makes another of the account's households the default for this and future sign-ins. */
export async function switchHousehold(
  table: TableClient, identity: AuthContext, householdId: unknown
): Promise<Pick<HouseholdMembership, "householdId" | "member">> {
  if (typeof householdId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(householdId)) {
    throw new HttpError(400, "Invalid household.");
  }
  const { memberships } = await accountMemberships(table, identity);
  const target = memberships.find((membership) => membership.householdId === householdId);
  if (!target) throw new HttpError(404, "Household not found.");
  await setDefaultHousehold(table, identity.userId, target);
  return { householdId: target.householdId, member: target.member };
}

/** Accepts an invitation while signed in, keeping the account's other households. */
export async function joinHousehold(
  table: TableClient, identity: AuthContext, code: unknown
): Promise<Pick<HouseholdMembership, "householdId" | "member">> {
  const invitation = await inspectInvitation(table, code);
  const user = await accountForMembership(table, identity);
  await consumeInvitation(table, invitation, identity.userId, identity.householdId);
  const target = { householdId: invitation.householdId, member: invitation.slot };
  await fillEmptyMemberName(table, target, identity.displayName ?? user.name ?? "");
  await setDefaultHousehold(table, identity.userId, target);
  return target;
}

/** Starts another household with the signed-in account as its first member. */
export async function createAdditionalHousehold(
  table: TableClient, config: Pick<Config, "allowNewHouseholds">, identity: AuthContext
): Promise<Pick<HouseholdMembership, "householdId" | "member">> {
  if (!config.allowNewHouseholds) throw new HttpError(403, "New household registration is currently closed.");
  const { user, memberships } = await accountMemberships(table, identity);
  assertBelowHouseholdLimit(memberships);
  await consumeRateLimit(table, `new-households:${identity.userId}`, 3, 30 * 24 * 60 * 60 * 1000);
  const householdId = `household-${randomBytes(32).toString("base64url").slice(0, 32)}`;
  await addHouseholdMembership(table, identity.userId, {
    householdId, member: "a", nameA: (identity.displayName ?? user.name ?? "").trim().slice(0, 60)
  }, identity.householdId);
  const target = { householdId, member: "a" as const };
  await setDefaultHousehold(table, identity.userId, target);
  return target;
}

/** The account's default household after it lost another one, so the device can continue there. */
export async function remainingHousehold(
  table: TableClient, userId: string
): Promise<Pick<HouseholdMembership, "householdId" | "member"> | null> {
  const user = await optionalEntity<UserEntity>(table, userPartition, `u-${userId}`);
  if (!user || user.userId !== userId || user.deletionRequestedAt || !user.householdId) return null;
  const membership = await verifiedMembership(table, userId, user.householdId);
  return membership && { householdId: membership.householdId, member: membership.member };
}

export async function fillEmptyMemberName(
  table: TableClient, context: Pick<AuthContext, "householdId" | "member">, name: string
): Promise<void> {
  const field = context.member === "a" ? "nameA" : "nameB";
  const household = await optionalEntity<HouseholdEntity>(table, householdPartition(context.householdId), "household");
  if (!household || household.deletedAt || household[field]?.trim() || !name.trim()) return;
  try {
    await table.updateEntity({
      partitionKey: householdPartition(context.householdId),
      rowKey: "household",
      [field]: name.trim().slice(0, 60)
    }, "Merge", { etag: household.etag });
  } catch (error) {
    // Another device or member changed the household concurrently; keep their value.
    if (statusCode(error) !== 412) throw error;
  }
}
