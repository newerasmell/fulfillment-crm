/** Warehouse scope shown in the header; it filters every screen (docs/DESIGN.md principle 3). */
export const SCOPES = ["all", "fhb", "eu"] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_COOKIE = "crm_scope";

export function isScope(v: unknown): v is Scope {
  return typeof v === "string" && (SCOPES as readonly string[]).includes(v);
}

/** Which connection types a scope includes. */
export const SCOPE_TYPES: Record<Scope, readonly string[]> = {
  all: ["FHB_V3", "FHB_JOY", "EUSHIPMENTS"],
  fhb: ["FHB_V3", "FHB_JOY"],
  eu: ["EUSHIPMENTS"],
};
