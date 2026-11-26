const tokenLike = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const invitationCode = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const jwt = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const digest = /\b[a-f0-9]{32,}\b/gi;
const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const secretAssignment = /\b(AccountKey|SharedAccessKey|SharedAccessSignature|Password|Secret|__Host-splitty|splitty-local)=[^;\s&"']+/gi;
const queryParameter = /([?&])([A-Za-z0-9_.~%-]+)=([^&\s"'#]*)/g;

/**
 * Removes values that must never reach a log sink: credentials, session and
 * invitation material, digests of them, email addresses and URL query strings.
 * The only query value kept is a numeric sync cursor.
 */
export function scrubLog(text: string): string {
  return text
    .replace(queryParameter, (_match, separator: string, name: string, value: string) =>
      name === "since" && /^\d+$/.test(value) ? `${separator}since=${value}` : `${separator}${name}=[redacted]`)
    .replace(secretAssignment, (_match, name: string) => `${name}=[redacted]`)
    .replace(jwt, "[redacted-token]")
    .replace(bearer, "Bearer [redacted]")
    .replace(invitationCode, "[redacted-invitation]")
    .replace(tokenLike, "[redacted-token]")
    .replace(digest, "[redacted-digest]")
    .replace(email, "[redacted-email]");
}
