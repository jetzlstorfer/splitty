export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds?: number) { super(message); }
}

export interface Config {
  origin: string;
  household?: string;
  storage:
    | { kind: "connectionString"; connection: string }
    | { kind: "rbac"; accountName: string; tenantId: string; clientId: string; clientSecret: string };
  memberAToken?: string;
  memberBToken?: string;
  nameA: string;
  nameB: string;
  local: boolean;
  allowNewHouseholds: boolean;
  entra?: { authority: string; clientId: string; clientSecret: string };
}

export function getConfig(): Config {
  const env = process.env;
  if (!env.APP_ORIGIN) throw new HttpError(503, "The backend is not configured. See the setup instructions.");
  let origin: URL;
  try { origin = new URL(env.APP_ORIGIN!); }
  catch { throw new HttpError(503, "APP_ORIGIN must be a valid origin."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const local = env.LOCAL_DEVELOPMENT === "true";
  const newHouseholdsSetting = env.ALLOW_NEW_HOUSEHOLDS?.trim();
  if (newHouseholdsSetting && !["true", "false"].includes(newHouseholdsSetting)) {
    throw new HttpError(503, "ALLOW_NEW_HOUSEHOLDS must be true or false.");
  }
  const allowNewHouseholds = newHouseholdsSetting === "true"
    || (!newHouseholdsSetting && local);
  if ((local && (!loopback || env.WEBSITE_INSTANCE_ID || env.NODE_ENV === "production"))
    || (!local && origin.protocol !== "https:")
    || origin.origin !== env.APP_ORIGIN) {
    throw new HttpError(503, "Invalid or unsafe backend configuration.");
  }
  const legacyValues = [env.HOUSEHOLD_ID, env.MEMBER_A_TOKEN, env.MEMBER_B_TOKEN];
  const hasLegacy = legacyValues.some(Boolean);
  if (hasLegacy && (legacyValues.some((value) => !value)
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(env.HOUSEHOLD_ID!)
    || !/^[a-zA-Z0-9_-]{43}$/.test(env.MEMBER_A_TOKEN!)
    || !/^[a-zA-Z0-9_-]{43}$/.test(env.MEMBER_B_TOKEN!)
    || env.MEMBER_A_TOKEN === env.MEMBER_B_TOKEN)) {
    throw new HttpError(503, "Configure a valid legacy household and two different 43-character member tokens.");
  }
  const entraValues = [env.ENTRA_AUTHORITY, env.ENTRA_CLIENT_ID, env.ENTRA_CLIENT_SECRET];
  const hasEntra = entraValues.some(Boolean);
  if (hasEntra && entraValues.some((value) => !value)) {
    throw new HttpError(503, "Configure the Entra authority, client ID, and client secret together.");
  }
  let entra: Config["entra"];
  if (hasEntra) {
    let authority: URL;
    try { authority = new URL(env.ENTRA_AUTHORITY!); }
    catch { throw new HttpError(503, "ENTRA_AUTHORITY must be a valid HTTPS authority URL."); }
    if (authority.protocol !== "https:" || !authority.hostname.endsWith(".ciamlogin.com")
      || authority.pathname === "/"
      || authority.search || authority.hash || authority.username || authority.password) {
      throw new HttpError(503, "ENTRA_AUTHORITY must be an HTTPS Entra External ID authority with a tenant path.");
    }
    entra = {
      authority: authority.href.replace(/\/$/, ""),
      clientId: env.ENTRA_CLIENT_ID!,
      clientSecret: env.ENTRA_CLIENT_SECRET!
    };
  }
  const storageIdentityValues = [
    env.TABLE_STORAGE_ACCOUNT_NAME,
    env.TABLE_STORAGE_TENANT_ID,
    env.TABLE_STORAGE_CLIENT_ID,
    env.TABLE_STORAGE_CLIENT_SECRET
  ];
  const hasConnectionString = Boolean(env.TABLE_STORAGE_CONNECTION_STRING);
  const hasStorageIdentity = storageIdentityValues.some(Boolean);
  if (hasConnectionString === hasStorageIdentity) {
    throw new HttpError(503, "Configure either TABLE_STORAGE_CONNECTION_STRING or the complete TABLE_STORAGE_* identity settings.");
  }
  let storage: Config["storage"];
  if (hasConnectionString) {
    storage = { kind: "connectionString", connection: env.TABLE_STORAGE_CONNECTION_STRING! };
  } else {
    if (storageIdentityValues.some((value) => !value)
      || !/^[a-z0-9]{3,24}$/.test(env.TABLE_STORAGE_ACCOUNT_NAME!)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.TABLE_STORAGE_TENANT_ID!)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.TABLE_STORAGE_CLIENT_ID!)) {
      throw new HttpError(503, "Configure a valid storage account name, tenant ID, client ID, and client secret together.");
    }
    storage = {
      kind: "rbac",
      accountName: env.TABLE_STORAGE_ACCOUNT_NAME!,
      tenantId: env.TABLE_STORAGE_TENANT_ID!,
      clientId: env.TABLE_STORAGE_CLIENT_ID!,
      clientSecret: env.TABLE_STORAGE_CLIENT_SECRET!
    };
  }
  if (!hasLegacy && !hasEntra) throw new HttpError(503, "Configure Entra sign-in or the legacy member-token settings.");
  return {
    origin: origin.origin, household: env.HOUSEHOLD_ID, storage,
    memberAToken: env.MEMBER_A_TOKEN, memberBToken: env.MEMBER_B_TOKEN,
    nameA: env.MEMBER_A_NAME?.trim() || "First person",
    nameB: env.MEMBER_B_NAME?.trim() || "Second person",
    local, entra, allowNewHouseholds
  };
}
