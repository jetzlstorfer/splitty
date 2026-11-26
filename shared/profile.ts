export interface AccountProfile {
  signInProvider?: "email" | "google" | "microsoft" | "unknown";
  displayName?: string;
  email?: string;
  pictureUrl?: string;
}

export function profileDisplayName(value: unknown): string | undefined {
  const name = typeof value === "string" ? value.trim().slice(0, 80) : "";
  // External ID stores "unknown" when sign-up does not collect a display name.
  return name && name.toLowerCase() !== "unknown" ? name : undefined;
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
