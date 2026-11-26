export interface AccountProfile {
  signInProvider?: "email" | "google" | "microsoft" | "unknown";
  displayName?: string;
  email?: string;
  pictureUrl?: string;
}

export function profilePictureUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
