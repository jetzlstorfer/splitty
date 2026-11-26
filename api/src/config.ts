export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds?: number) { super(message); }
}

export interface Config {
  origin: string;
  storage:
    | { kind: "connectionString"; connection: string }
    | { kind: "rbac"; accountName: string; tenantId: string; clientId: string; clientSecret: string };
  local: boolean;
  localSignIn?: { household: string; nameA: string; nameB: string };
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
  const localHousehold = env.LOCAL_HOUSEHOLD_ID?.trim();
  if (localHousehold && (!local || !/^[a-zA-Z0-9_-]{1,100}$/.test(localHousehold))) {
    throw new HttpError(503, "LOCAL_HOUSEHOLD_ID requires LOCAL_DEVELOPMENT=true and a valid household identifier.");
  }
  const localSignIn = localHousehold ? {
    household: localHousehold,
    nameA: env.LOCAL_MEMBER_A_NAME?.trim().slice(0, 60) || "Alex",
    nameB: env.LOCAL_MEMBER_B_NAME?.trim().slice(0, 60) || "Sam"
  } : undefined;
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
  if (!hasEntra && !localSignIn) throw new HttpError(503, "Configure Entra sign-in, or LOCAL_HOUSEHOLD_ID for local development.");
  return { origin: origin.origin, storage, local, localSignIn, entra, allowNewHouseholds };
}
