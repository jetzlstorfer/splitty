import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import type { Member } from "../../shared/model";
import type { AuthContext } from "./auth";
import { HttpError } from "./config";
import { addMembershipIndex, removeMembershipIndex } from "./membershipIndex";
import { consumeRateLimit } from "./rateLimit";
import { optionalEntity, statusCode } from "./storage";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const householdPartition = (householdId: string) => `h-${householdId}`;
const invitationRow = (id: string) => `i-${id}`;
const slotRow = (member: Member) => `invite-slot-${member}`;
const lifetime = 7 * 24 * 60 * 60 * 1000;

interface InvitationEntity {
  id: string;
  slot: Member;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

interface SlotReservation { id: string; expiresAt: number }
interface MembershipEntity { member: Member; active: boolean }
interface HouseholdEntity { deletedAt?: number }

export interface Invitation {
  id: string;
  slot: Member;
  expiresAt: number;
}

export interface InvitationTarget { householdId: string; id: string; slot: Member }

export async function inspectInvitation(table: Pick<TableClient, "getEntity">, code: unknown): Promise<InvitationTarget> {
  if (typeof code !== "string") throw new HttpError(400, "Invalid invitation.");
  const separator = code.indexOf(".");
  const householdId = code.slice(0, separator);
  const secret = code.slice(separator + 1);
  if (separator < 1 || !/^[a-zA-Z0-9_-]{1,100}$/.test(householdId)
    || !/^[a-zA-Z0-9_-]{43}$/.test(secret)) {
    throw new HttpError(400, "Invalid invitation.");
  }
  const id = digest(secret);
  const partitionKey = householdPartition(householdId);
  const household = await optionalEntity<HouseholdEntity>(table, partitionKey, "household");
  if (!household || household.deletedAt) {
    throw new HttpError(410, "This invitation has expired or was already used.");
  }
  const invitation = await optionalEntity<InvitationEntity>(table, partitionKey, invitationRow(id));
  const reservation = await optionalEntity<SlotReservation>(table, partitionKey, slotRow(invitation?.slot ?? "a"));
  if (!invitation || invitation.id !== id || (invitation.slot !== "a" && invitation.slot !== "b")
    || invitation.expiresAt <= Date.now()
    || reservation?.id !== id || reservation.expiresAt <= Date.now()) {
    throw new HttpError(410, "This invitation has expired or was already used.");
  }
  return { householdId, id, slot: invitation.slot };
}

export async function consumeInvitation(
  table: TableClient, target: InvitationTarget, userId: string
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(userId)) throw new HttpError(400, "Invalid household membership.");
  const partitionKey = householdPartition(target.householdId);
  const household = await optionalEntity<HouseholdEntity>(table, partitionKey, "household");
  if (!household || household.deletedAt) {
    throw new HttpError(410, "This invitation has expired or was already used.");
  }
  const invitation = await optionalEntity<InvitationEntity>(table, partitionKey, invitationRow(target.id));
  const reservation = await optionalEntity<SlotReservation>(table, partitionKey, slotRow(target.slot));
  if (!invitation || invitation.expiresAt <= Date.now()
    || !reservation || reservation.id !== target.id || reservation.expiresAt <= Date.now()) {
    throw new HttpError(410, "This invitation has expired or was already used.");
  }
  if (await optionalEntity<MembershipEntity>(table, partitionKey, `m-${userId}`)) {
    throw new HttpError(409, "This account is already a member of this household.");
  }
  await addMembershipIndex(table, userId, target.householdId);
  try {
    await table.submitTransaction([
      ["delete", { partitionKey, rowKey: invitationRow(target.id) }],
      ["delete", { partitionKey, rowKey: slotRow(target.slot) }],
      ["create", {
        partitionKey,
        rowKey: `m-${userId}`,
        userId,
        member: target.slot,
        active: true,
        membershipId: randomUUID()
      }]
    ]);
  } catch (error) {
    if (!await optionalEntity<MembershipEntity>(table, partitionKey, `m-${userId}`)) {
      await removeMembershipIndex(table, userId, target.householdId);
    }
    if (statusCode(error) === 409 || statusCode(error) === 404) {
      throw new HttpError(410, "This invitation has expired or was already used.");
    }
    throw error;
  }
}

export async function listInvitations(table: TableClient, context: AuthContext): Promise<Invitation[]> {
  const partitionKey = householdPartition(context.householdId);
  const results: Invitation[] = [];
  for await (const entity of table.listEntities<InvitationEntity>({
    queryOptions: { filter: `PartitionKey eq '${partitionKey}'` }
  })) {
    if (typeof entity.id === "string" && /^[a-f0-9]{64}$/.test(entity.id)
      && (entity.slot === "a" || entity.slot === "b")
      && typeof entity.expiresAt === "number" && entity.expiresAt > Date.now()) {
      results.push({ id: entity.id, slot: entity.slot, expiresAt: entity.expiresAt });
    }
  }
  return results.sort((a, b) => a.expiresAt - b.expiresAt);
}

export async function createInvitation(table: TableClient, context: AuthContext): Promise<{ invitation: Invitation; code: string }> {
  const slot: Member = context.member === "a" ? "b" : "a";
  const partitionKey = householdPartition(context.householdId);
  for await (const entity of table.listEntities<MembershipEntity>({
    queryOptions: { filter: `PartitionKey eq '${partitionKey}' and member eq '${slot}' and active eq true` }
  })) {
    if (typeof entity.rowKey === "string" && entity.rowKey.startsWith("m-")) {
      throw new HttpError(409, "That household member slot is already occupied.");
    }
  }

  const createdAt = Date.now();
  const expiresAt = createdAt + lifetime;
  const reservation = await optionalEntity<SlotReservation>(table, partitionKey, slotRow(slot));
  if (reservation) {
    if (reservation.expiresAt > createdAt) {
      throw new HttpError(409, "An active invitation already exists for that member slot.");
    }
    const oldInvitation = await optionalEntity<InvitationEntity>(table, partitionKey, invitationRow(reservation.id));
    try {
      await table.submitTransaction(oldInvitation
        ? [
          ["delete", { partitionKey, rowKey: invitationRow(reservation.id) }],
          ["delete", { partitionKey, rowKey: slotRow(slot) }]
        ]
        : [["delete", { partitionKey, rowKey: slotRow(slot) }]]);
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
    }
  }

  await consumeRateLimit(table, `invitations:${context.householdId}`, 10, 24 * 60 * 60 * 1000);
  const secret = randomBytes(32).toString("base64url");
  const code = `${context.householdId}.${secret}`;
  const id = digest(secret);
  try {
    await table.submitTransaction([
      ["create", {
        partitionKey,
        rowKey: invitationRow(id),
        id,
        slot,
        createdBy: context.userId,
        createdAt,
        expiresAt
      }],
      ["create", {
        partitionKey,
        rowKey: slotRow(slot),
        id,
        expiresAt
      }]
    ]);
  } catch (error) {
    if (statusCode(error) === 409) throw new HttpError(409, "An active invitation already exists for that member slot.");
    throw error;
  }
  return { invitation: { id, slot, expiresAt }, code };
}

export async function revokeInvitation(table: TableClient, context: AuthContext, id: unknown): Promise<void> {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new HttpError(400, "Invalid invitation.");
  const partitionKey = householdPartition(context.householdId);
  const invitation = await optionalEntity<InvitationEntity>(table, partitionKey, invitationRow(id));
  if (!invitation) throw new HttpError(404, "Invitation not found.");
  const reservation = await optionalEntity<SlotReservation>(table, partitionKey, slotRow(invitation.slot));

  try {
    await table.submitTransaction(reservation?.id === id
      ? [
        ["delete", { partitionKey, rowKey: invitationRow(id) }],
        ["delete", { partitionKey, rowKey: slotRow(invitation.slot) }]
      ]
      : [["delete", { partitionKey, rowKey: invitationRow(id) }]]);
  } catch (error) {
    if (statusCode(error) === 404) throw new HttpError(404, "Invitation not found.");
    throw error;
  }
}

export async function clearInvitationSlot(table: TableClient, householdId: string, slot: Member): Promise<void> {
  const partitionKey = householdPartition(householdId);
  const reservation = await optionalEntity<SlotReservation>(table, partitionKey, slotRow(slot));
  if (!reservation) return;
  const invitation = await optionalEntity<InvitationEntity>(table, partitionKey, invitationRow(reservation.id));
  try {
    await table.submitTransaction(invitation
      ? [
        ["delete", { partitionKey, rowKey: invitationRow(reservation.id) }],
        ["delete", { partitionKey, rowKey: slotRow(slot) }]
      ]
      : [["delete", { partitionKey, rowKey: slotRow(slot) }]]);
  } catch (error) {
    if (statusCode(error) !== 404) throw error;
  }
}
