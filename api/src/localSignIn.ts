import { createHash } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import { createMembership, createUserSession } from "./auth";
import { HttpError, type Config } from "./config";
import { optionalEntity, statusCode } from "./storage";

const householdPartition = (householdId: string) => `h-${householdId}`;

interface HouseholdRecord { deletedAt?: number }

/**
 * Signs a synthetic member into the configured local household. Only local development
 * (a loopback origin outside Azure) can enable this, so tests and seeded sessions need no
 * identity provider.
 */
export async function signInLocally(
  config: Config, table: TableClient, member: unknown
): Promise<{ cookie: string; deviceKey: string }> {
  const local = config.localSignIn;
  if (!config.local || !local) throw new HttpError(404, "Endpoint not found.");
  if (member !== "a" && member !== "b") throw new HttpError(400, "Choose a household member.");
  const householdId = local.household;
  const userId = `local-${createHash("sha256").update(`${householdId}\0${member}`).digest("hex").slice(0, 40)}`;
  const name = member === "a" ? local.nameA : local.nameB;

  const household = await optionalEntity<HouseholdRecord>(table, householdPartition(householdId), "household");
  if (household?.deletedAt) throw new HttpError(410, "This household is scheduled for deletion.");
  if (!household) {
    try {
      await table.createEntity({
        partitionKey: householdPartition(householdId), rowKey: "household", nameA: local.nameA, nameB: local.nameB
      });
    } catch (error) { if (statusCode(error) !== 409) throw error; }
  }
  await table.upsertEntity({
    partitionKey: "users", rowKey: `u-${userId}`, userId, issuer: "local-development",
    subject: `${householdId}:${member}`, name, householdId, member, membershipInitialized: true
  }, "Replace");
  try { await createMembership(table, householdId, userId, member); }
  catch (error) { if (statusCode(error) !== 409) throw error; }
  return createUserSession(config, table, { userId, householdId, member, displayName: name, signInProvider: "local" });
}
