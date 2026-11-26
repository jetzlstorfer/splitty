import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import type { Member } from "../../shared/model";
import type { Config } from "./config";
import { HttpError } from "./config";
import { clearInvitationSlot } from "./invitations";
import { optionalEntity, statusCode } from "./storage";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const householdPartition = (householdId: string) => `h-${householdId}`;
const slotReservation = (member: Member) => `invite-slot-${member}`;

interface LegacyReservation {
  id: string;
  member?: string;
  expiresAt: number;
}

interface Membership {
  userId: string;
  member: Member;
  active: boolean;
}

interface Household { nameA?: string; nameB?: string; deletedAt?: number }

export function legacyMemberForToken(config: Config, token: unknown): Member {
  if (!config.household || !config.memberAToken || !config.memberBToken) {
    throw new HttpError(404, "Legacy member-token sign-in is not configured.");
  }
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(token)) {
    throw new HttpError(400, "Enter a valid member token.");
  }
  const provided = Buffer.from(digest(token), "hex");
  const tokenA = timingSafeEqual(provided, Buffer.from(digest(config.memberAToken), "hex"));
  const tokenB = timingSafeEqual(provided, Buffer.from(digest(config.memberBToken), "hex"));
  if (!tokenA && !tokenB) throw new HttpError(401, "Invalid member token.");
  return tokenA ? "a" : "b";
}

export function verifyLegacyClaim(
  config: Config, member: Member, tokenDigest: unknown
): void {
  if (typeof tokenDigest !== "string" || !/^[a-f0-9]{64}$/.test(tokenDigest)) {
    throw new HttpError(400, "Invalid household claim.");
  }
  const token = member === "a" ? config.memberAToken : config.memberBToken;
  if (!config.household || !token || !timingSafeEqual(Buffer.from(tokenDigest), Buffer.from(digest(token)))) {
    throw new HttpError(401, "The member token changed before sign-in completed. Please try again.");
  }
}

export async function ensureLegacyHousehold(
  table: TableClient, config: Config
): Promise<void> {
  if (!config.household) throw new HttpError(404, "Legacy member-token sign-in is not configured.");
  const partitionKey = householdPartition(config.household);
  const existing = await optionalEntity<Household>(table, partitionKey, "household");
  if (existing?.deletedAt) throw new HttpError(410, "This household is scheduled for deletion.");
  if (existing) return;
  try {
    await table.createEntity({
      partitionKey, rowKey: "household", nameA: config.nameA, nameB: config.nameB
    });
  } catch (error) {
    if (statusCode(error) !== 409) throw error;
  }
}

export async function claimLegacyMemberSlot(
  table: TableClient, config: Config, userId: string, member: Member
): Promise<void> {
  if (!config.household) throw new HttpError(404, "Legacy member-token sign-in is not configured.");
  await ensureLegacyHousehold(table, config);
  const partitionKey = householdPartition(config.household);
  const reservationKey = slotReservation(member);
  const reservation = await optionalEntity<LegacyReservation>(table, partitionKey, reservationKey);
  const reservationId = `legacy-claim-${userId}`;
  const membership = await optionalEntity<Membership>(table, partitionKey, `m-${userId}`);
  if (membership) {
    if (membership.userId !== userId || membership.member !== member || membership.active !== true) {
      throw new HttpError(409, "This account already has a different household membership.");
    }
    if (reservation?.id === reservationId) return;
    if (!reservation) return;
  }
  if (reservation && reservation.expiresAt <= Date.now()) {
    await clearInvitationSlot(table, config.household, member);
  } else if (reservation && reservation.id !== reservationId) {
    throw new HttpError(409, "That household member slot is already reserved.");
  }

  const currentReservation = await optionalEntity<LegacyReservation>(table, partitionKey, reservationKey);
  if (currentReservation?.id === reservationId) {
    try {
      await table.createEntity({
        partitionKey, rowKey: `m-${userId}`, userId, member, active: true, membershipId: randomUUID()
      });
    } catch (error) {
      if (statusCode(error) !== 409) throw error;
      const current = await optionalEntity<Membership>(table, partitionKey, `m-${userId}`);
      if (!current || current.userId !== userId || current.member !== member || current.active !== true) {
        throw new HttpError(409, "That household member slot is already occupied.");
      }
    }
    return;
  }

  const partitionFilter = `PartitionKey eq '${partitionKey}' and member eq '${member}' and active eq true`;
  for await (const entity of table.listEntities<Membership>({ queryOptions: { filter: partitionFilter } })) {
    if (typeof entity.rowKey === "string" && entity.rowKey.startsWith("m-")) {
      if (entity.rowKey !== `m-${userId}`) {
        throw new HttpError(409, "That household member slot is already occupied.");
      }
    }
  }

  try {
    await table.submitTransaction([
      ["create", {
        partitionKey,
        rowKey: reservationKey,
        id: reservationId,
        member,
        userId,
        expiresAt: Number.MAX_SAFE_INTEGER
      }],
      ["create", {
        partitionKey,
        rowKey: `m-${userId}`,
        userId,
        member,
        active: true,
        membershipId: randomUUID()
      }]
    ]);
  } catch (error) {
    if (statusCode(error) === 409) {
      const [current, claimed] = await Promise.all([
        optionalEntity<LegacyReservation>(table, partitionKey, reservationKey),
        optionalEntity<Membership>(table, partitionKey, `m-${userId}`)
      ]);
      if (current?.id === reservationId && claimed?.userId === userId
        && claimed.member === member && claimed.active === true) return;
      throw new HttpError(409, "That household member slot is already occupied.");
    }
    throw error;
  }
}
