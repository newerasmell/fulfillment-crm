/**
 * What the daily watcher fetches (SPEC §8, the same URLs as tools/fetch_specs.sh) and which of our code each
 * source feeds — the upgrade brief names these files. Paths follow the adapter layout in CLAUDE.md.
 */

export type SpecVendor = "FHB_V3" | "FHB_JOY" | "EUSHIPMENTS";

export interface SpecSource {
  vendor: SpecVendor;
  label: string;
  url: string;
  format: "openapi" | "postman";
  /** Raw copy in the repo and its rendered reference (refreshed by `pnpm docs:refresh`). */
  rawFile: string;
  reference: string;
  adapterDir: string;
}

export const SPEC_SOURCES: readonly SpecSource[] = [
  {
    vendor: "FHB_V3",
    label: "FHB Kika API v3",
    url: "https://api.fhb.sk/v3/openapi",
    format: "openapi",
    rawFile: "docs/integrations/raw/fhb-kika-v3.openapi.json",
    reference: "docs/integrations/fhb-kika-v3.md",
    adapterDir: "src/integrations/fhb-v3",
  },
  {
    vendor: "FHB_JOY",
    label: "FHB Joy",
    url: "https://api.fhb.sk/joy/openapi",
    format: "openapi",
    rawFile: "docs/integrations/raw/fhb-joy.openapi.json",
    reference: "docs/integrations/fhb-joy.md",
    adapterDir: "src/integrations/fhb-joy",
  },
  {
    vendor: "EUSHIPMENTS",
    label: "euShipments",
    url: "https://documenter.gw.postman.com/api/collections/26992907/2s93Y2S2Q8?segregateAuth=true&versionTag=latest",
    format: "postman",
    rawFile: "docs/integrations/raw/eushipments.postman_collection.json",
    reference: "docs/integrations/eushipments.md",
    adapterDir: "src/integrations/eushipments",
  },
];

/** Watch-source ids that are not vendor spec URLs. */
export const SHOPIFY_SOURCE = "SHOPIFY";
export const LIVE_CHECK_SOURCE = "LIVE_CHECK";

export const sourceLabel = (id: string) =>
  SPEC_SOURCES.find((s) => s.vendor === id)?.label ??
  (id === SHOPIFY_SOURCE ? "Shopify Admin API" : id === LIVE_CHECK_SOURCE ? "Live check" : id);
