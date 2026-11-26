import type { AccountInfo, ConfidentialClientApplication } from "@azure/msal-node";
import type { AccountProfile } from "../../shared/profile";

type Provider = NonNullable<AccountProfile["signInProvider"]>;

function providerId(value: unknown, issuer?: string): Provider {
  const id = typeof value === "string" ? value.trim().toLowerCase().replace(/\/$/, "") : "";
  if (["google", "google.com", "accounts.google.com", "https://accounts.google.com"].includes(id)) return "google";
  if (["microsoftaccount", "live.com", "login.live.com", "externalazuread"].includes(id)
    || /^https:\/\/(?:login\.live\.com|login\.microsoftonline\.com|sts\.windows\.net)(?:\/|$)/.test(id)) return "microsoft";
  if (id === "email" || id === "mail" || (id === issuer?.toLowerCase().replace(/\/$/, "")
    && /^https:\/\/[^/]+\.ciamlogin\.com\//.test(id))) return "email";
  return "unknown";
}

export function tokenProvider(claims: Record<string, unknown>, issuer: string): Provider {
  return providerId(claims.idp ?? claims.identityProvider ?? claims.identityprovider
    ?? claims["http://schemas.microsoft.com/identity/claims/identityprovider"], issuer);
}

export function directoryProvider(identities: unknown): Provider {
  if (!Array.isArray(identities)) return "unknown";
  const methods = new Set<Provider>();
  for (const identity of identities) {
    // Graph also includes a directory UPN for both local and federated customers.
    if (identity?.signInType === "userPrincipalName") continue;
    methods.add(identity?.signInType === "emailAddress" ? "email"
      : identity?.signInType === "federated" ? providerId(identity.issuer) : "unknown");
  }
  // Linked identities are account metadata, not evidence of which method was used this time.
  return methods.size === 1 ? [...methods][0] : "unknown";
}

export async function lookupDirectoryProvider(
  client: Pick<ConfidentialClientApplication, "acquireTokenSilent">, account: AccountInfo
): Promise<Provider> {
  try {
    // Do not add a consent requirement to sign-in. Only use an existing delegated grant.
    const token = await client.acquireTokenSilent({ account, scopes: ["https://graph.microsoft.com/User.Read"] });
    const response = await fetch("https://graph.microsoft.com/v1.0/me?$select=identities", {
      headers: { Authorization: `Bearer ${token.accessToken}` }, redirect: "error", signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) {
      console.warn(`Splitty sign-in identity lookup returned HTTP ${response.status}.`);
      return "unknown";
    }
    const profile: unknown = await response.json();
    return directoryProvider(profile && typeof profile === "object" && "identities" in profile ? profile.identities : undefined);
  } catch {
    // An optional profile lookup must not reject an otherwise valid login. Never log tokens or Graph responses.
    console.warn("Splitty could not read sign-in identities. Check delegated User.Read consent and Graph availability.");
    return "unknown";
  }
}
