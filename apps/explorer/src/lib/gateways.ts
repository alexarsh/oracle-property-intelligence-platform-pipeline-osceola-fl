/**
 * Gateway URL derivation. CIDs are the identity; these URLs are conveniences
 * derived from them at render time and never stored.
 *
 * @module gateways
 */

export interface Gateway {
  key: string;
  label: string;
  /** Origin, no trailing slash. */
  origin: string;
  /** True for public gateways this project does not operate (the independent-retrieval proof). */
  independent: boolean;
}

export const GATEWAYS: readonly Gateway[] = [
  { key: "ipfs.io", label: "ipfs.io", origin: "https://ipfs.io", independent: true },
  { key: "dweb.link", label: "dweb.link", origin: "https://dweb.link", independent: true },
  {
    key: "filebase",
    label: "Filebase (pinning vendor)",
    origin: "https://ipfs.filebase.io",
    independent: false,
  },
];

/** `https://<gateway>/ipfs/<cid>[/<sub path>]`. */
export function gatewayUrl(
  gateway: Gateway | string,
  cid: string,
  subPath?: string | null,
): string {
  const origin = typeof gateway === "string" ? gateway.replace(/\/$/, "") : gateway.origin;
  const suffix = subPath ? `/${subPath.split("/").map(encodeURIComponent).join("/")}` : "";
  return `${origin}/ipfs/${cid}${suffix}`;
}

/** Resolve a gateway key or origin to a whitelisted entry (SSRF guard for the verify route). */
export function resolveGateway(keyOrOrigin: string): Gateway | null {
  const needle = keyOrOrigin.trim().replace(/\/$/, "");
  return GATEWAYS.find((g) => g.key === needle || g.origin === needle) ?? null;
}

/** CIDv1 base32 sanity check (same regex as the shared manifest contract). */
export function isCidV1(cid: string): boolean {
  return /^baf[a-z2-7]{50,}$/.test(cid);
}
