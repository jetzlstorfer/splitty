import type { TableClient } from "@azure/data-tables";
import { defaultInsuranceTodoSetting, type InsuranceTodoSetting, type Member } from "../../shared/model";
import type { AuthContext } from "./auth";
import { HttpError } from "./config";
import { clearInvitationSlot } from "./invitations";
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

async function detachUser(table: TableClient, userId: string, householdId: string, member: Member): Promise<void> {
  const user = await optionalEntity<UserEntity>(table, userPartition, `u-${userId}`);
  if (!user || user.userId !== userId) throw new HttpError(404, "Household member not found.");
  if (user.householdId !== householdId || user.member !== member) return;
  await table.updateEntity({
    partitionKey: userPartition,
    rowKey: `u-${userId}`,
    householdId: "",
    member: "",
    membershipInitialized: false
  }, "Merge", { etag: user.etag });
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

async function removeMembership(table: TableClient, householdId: string, userId: string): Promise<void> {
  try { await table.deleteEntity(householdPartition(householdId), `m-${userId}`); }
  catch (error) { if (statusCode(error) !== 404) throw error; }
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
  await removeMembership(table, context.householdId, context.userId);
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
  await removeMembership(table, context.householdId, target.userId);
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
    await removeMembership(table, context.householdId, member.userId);
    await clearInvitationSlot(table, context.householdId, member.member);
  }
}

export async function deleteAccount(table: TableClient, context: AuthContext): Promise<void> {
  const household = await activeHousehold(table, context.householdId);
  const user = await optionalEntity<UserEntity>(table, userPartition, `u-${context.userId}`);
  if (!user || user.userId !== context.userId) throw new HttpError(404, "Account not found.");
  const now = Date.now();
  await table.updateEntity({
    partitionKey: userPartition,
    rowKey: `u-${context.userId}`,
    deletionRequestedAt: now,
    purgeAfter: now + deletionGraceMs
  }, "Merge", { etag: user.etag });
  await removeMembership(table, context.householdId, context.userId);
  await table.updateEntity({
    partitionKey: householdPartition(context.householdId),
    rowKey: "household",
    [context.member === "a" ? "nameA" : "nameB"]: ""
  }, "Merge", { etag: household.etag });
  await clearInvitationSlot(table, context.householdId, context.member);
  await scheduleEmptyHouseholdDeletion(table, context.householdId);
}
