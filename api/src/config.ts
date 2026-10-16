export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface Config {
  origin: string;
  household: string;
  connection: string;
  memberAToken: string;
  memberBToken: string;
  nameA: string;
  nameB: string;
  local: boolean;
}

export function getConfig(): Config {
  const env = process.env;
  const required = ["APP_ORIGIN", "HOUSEHOLD_ID", "TABLE_STORAGE_CONNECTION_STRING", "MEMBER_A_TOKEN", "MEMBER_B_TOKEN"] as const;
  if (required.some((key) => !env[key])) throw new HttpError(503, "The backend is not configured. See the setup instructions.");
  let origin: URL;
  try { origin = new URL(env.APP_ORIGIN!); }
  catch { throw new HttpError(503, "APP_ORIGIN must be a valid origin."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const local = env.LOCAL_DEVELOPMENT === "true";
  if ((local && (!loopback || env.WEBSITE_INSTANCE_ID || env.NODE_ENV === "production"))
    || (!local && origin.protocol !== "https:")
    || origin.origin !== env.APP_ORIGIN
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(env.HOUSEHOLD_ID!)) {
    throw new HttpError(503, "Invalid or unsafe backend configuration.");
  }
  const memberAToken = env.MEMBER_A_TOKEN!, memberBToken = env.MEMBER_B_TOKEN!;
  if (!/^[a-zA-Z0-9_-]{43}$/.test(memberAToken) || !/^[a-zA-Z0-9_-]{43}$/.test(memberBToken) || memberAToken === memberBToken) {
    throw new HttpError(503, "Configure two different 43-character member tokens.");
  }
  return {
    origin: origin.origin, household: env.HOUSEHOLD_ID!, connection: env.TABLE_STORAGE_CONNECTION_STRING!,
    memberAToken, memberBToken, nameA: env.MEMBER_A_NAME?.trim() || "First person",
    nameB: env.MEMBER_B_NAME?.trim() || "Second person",
    local
  };
}
