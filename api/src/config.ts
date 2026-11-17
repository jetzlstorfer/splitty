export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds?: number) { super(message); }
}

export interface Config {
  origin: string;
  household?: string;
  connection: string;
  memberAToken?: string;
  memberBToken?: string;
  nameA: string;
  nameB: string;
  local: boolean;
  entra?: { authority: string; clientId: string; clientSecret: string };
}

export function getConfig(): Config {
  const env = process.env;
  const required = ["APP_ORIGIN", "TABLE_STORAGE_CONNECTION_STRING"] as const;
  if (required.some((key) => !env[key])) throw new HttpError(503, "The backend is not configured. See the setup instructions.");
  let origin: URL;
  try { origin = new URL(env.APP_ORIGIN!); }
  catch { throw new HttpError(503, "APP_ORIGIN must be a valid origin."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const local = env.LOCAL_DEVELOPMENT === "true";
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
      || authority.search || authority.hash || authority.username || authority.password) {
      throw new HttpError(503, "ENTRA_AUTHORITY must be an HTTPS Entra External ID authority.");
    }
    entra = {
      authority: authority.href.replace(/\/$/, ""),
      clientId: env.ENTRA_CLIENT_ID!,
      clientSecret: env.ENTRA_CLIENT_SECRET!
    };
  }
  if (!hasLegacy && !hasEntra) throw new HttpError(503, "Configure Entra sign-in or the legacy member-token settings.");
  return {
    origin: origin.origin, household: env.HOUSEHOLD_ID, connection: env.TABLE_STORAGE_CONNECTION_STRING!,
    memberAToken: env.MEMBER_A_TOKEN, memberBToken: env.MEMBER_B_TOKEN,
    nameA: env.MEMBER_A_NAME?.trim() || "First person",
    nameB: env.MEMBER_B_NAME?.trim() || "Second person",
    local, entra
  };
}
