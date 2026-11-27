import { useEffect, useState } from "react";
import type { Member } from "../shared/model";
import { missingBackupRecords, type BackupRecords } from "./backup";
import { accountDatabaseFor, anonymousRecords, type SplittyDatabase } from "./db";

export interface LocalRecords extends BackupRecords {
  /** Who this device recorded as its owner before sign-in. */
  member: Member;
  /** The signed-in member of the household whose database was checked. */
  householdMember: Member;
}

interface Account { userId?: string; householdId?: string; member: Member }

async function findLocalRecords(database: SplittyDatabase, account: Required<Account>): Promise<LocalRecords | null> {
  // After a household switch the new database is active before the identity refreshes; never pair the two.
  if (await accountDatabaseFor(account.userId, account.householdId) !== database.name) return null;
  const local = await anonymousRecords();
  if (!local) return null;
  const missing = await missingBackupRecords(local, database);
  return missing.entries.length || missing.todos.length
    ? { ...missing, member: local.member, householdMember: account.member } : null;
}

/**
 * Records saved on this device without an account that the signed-in household does not contain.
 * They are never moved automatically; `version` re-checks after the ledger changes, e.g. after adding them.
 */
export function useLocalRecords(database: SplittyDatabase | undefined, account: Account | null, version: string): LocalRecords | null {
  const { userId, householdId, member } = account ?? {};
  const key = database && userId && householdId && member ? `${database.name}\0${userId}\0${householdId}\0${member}` : "";
  const [result, setResult] = useState<{ key: string; records: LocalRecords | null }>({ key: "", records: null });
  useEffect(() => {
    if (!key || !database || !userId || !householdId || !member) return;
    let active = true;
    findLocalRecords(database, { userId, householdId, member }).then(
      (records) => { if (active) setResult({ key, records }); },
      () => { if (active) setResult({ key, records: null }); }
    );
    return () => { active = false; };
  }, [key, database, userId, householdId, member, version]);
  return key && result.key === key ? result.records : null;
}

/** Re-checks right before writing that the signed-in identity still owns the database. */
export async function ownsDatabase(database: SplittyDatabase, account: Account | null): Promise<boolean> {
  return !!account?.userId && !!account.householdId
    && await accountDatabaseFor(account.userId, account.householdId) === database.name;
}
