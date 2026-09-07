/**
 * BBB pages are a React/Redux app whose server render embeds the full store as
 * `window.__PRELOADED_STATE__ = {...};` inside a `<script>` tag. Category pages
 * carry `searchResult` (the same JSON `/api/search` returns) and profile pages
 * carry `businessProfile`. Parsing that blob is far more stable than the DOM,
 * so both parsers read it first and fall back to markup only when it is absent.
 *
 * @module sources/bbb/preloaded-state
 */

const MARKER = /window\.__PRELOADED_STATE__\s*=\s*/;

/**
 * Extract and parse the `__PRELOADED_STATE__` object from a BBB HTML page.
 * Uses brace matching that is aware of JSON string literals, so `}` inside
 * business descriptions cannot truncate the object. Returns `null` when the
 * marker is missing (e.g. a Cloudflare challenge page) or the JSON is invalid.
 */
export function extractPreloadedState(html: string): unknown {
  const m = MARKER.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  if (html[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Walk `path` through nested plain objects / arrays; `undefined` when any hop is missing. */
export function get(value: unknown, path: readonly (string | number)[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return cur;
}

/** Trimmed non-empty string or `null`. */
export function asString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Finite number (numeric strings accepted) or `null`. */
export function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Integer (rounded from a finite number) or `null`. */
export function asInt(v: unknown): number | null {
  const n = asNumber(v);
  return n === null ? null : Math.round(n);
}

/** Boolean or `null` (no truthiness coercion — BBB uses `null` for "unknown"). */
export function asBoolean(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** Array or an empty array. */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Plain object or `null`. */
export function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
