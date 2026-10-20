import { KNOWN_ENTITLEMENTS, type Scope } from "../tokens";
import type { ProductScopeMap, ScopeMapping } from "./types";

const SCOPES: ReadonlySet<string> = new Set<Scope>(["Diet", "Training", "Combo", "CIP"]);
const PRODUCT_ID = /^\d{6,25}$/;

/**
 * Data-driven mapping keyed by the CRM Product record id. The table is supplied by configuration after the Product
 * Manager approves it; THERE IS NO DEFAULT TABLE and no inference from product names. An id without an entry maps to
 * `null` and the issuer refuses (fail closed).
 */
export class ExplicitProductMap implements ProductScopeMap {
  private readonly table = new Map<string, ScopeMapping>();

  constructor(entries: Readonly<Record<string, ScopeMapping>> = {}) {
    for (const [id, m] of Object.entries(entries)) {
      if (!PRODUCT_ID.test(id)) throw new Error("PRODUCT_MAP_INVALID");
      if (!SCOPES.has(m.scope)) throw new Error("PRODUCT_MAP_INVALID");
      if (m.entitlements.some((e) => !KNOWN_ENTITLEMENTS.has(e))) throw new Error("PRODUCT_MAP_INVALID");
      const c = m.commercial;
      if (c !== undefined && ((c.level !== undefined && (typeof c.level !== "string" || c.level.length > 40)) || (c.duration_months !== undefined && (!Number.isInteger(c.duration_months) || c.duration_months < 1 || c.duration_months > 60)))) throw new Error("PRODUCT_MAP_INVALID");
      this.table.set(id, { scope: m.scope, entitlements: [...new Set(m.entitlements)].sort(), ...(c ? { commercial: { ...c } } : {}) });
    }
  }

  map(product: { id: string }): ScopeMapping | null {
    return this.table.get(product.id) ?? null;
  }
}

/** Parses `SIX2FIT_PRODUCT_SCOPE_MAP` (JSON: `{ "<productId>": { "scope": "Combo", "entitlements": ["cellulite"] } }`). Empty = no mapping. */
export function productMapFromEnv(raw: string | undefined): ExplicitProductMap {
  if (!raw || raw.trim() === "") return new ExplicitProductMap();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PRODUCT_MAP_INVALID");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PRODUCT_MAP_INVALID");
  return new ExplicitProductMap(parsed as Record<string, ScopeMapping>);
}
