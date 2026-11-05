import { getTranslations } from "next-intl/server";
import { SHOPIFY_API_VERSION } from "@/integrations/shopify/config";
import { REQUIRED_SCOPES_TEXT } from "@/integrations/shopify/scopes";
import { CopyValue } from "./copy";

/** The CRM's public address (the App URL field); never a secret. */
export function crmPublicUrl(env: Record<string, string | undefined> = process.env) {
  return (env.APP_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "") || null;
}

function Row({ field, children }: { field: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[14rem_1fr] sm:gap-3">
      <div className="text-sm font-semibold">{field}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * Step by step, field by field as the Shopify Dev Dashboard shows them (Create version), with every value to paste:
 * the store's own app the CRM connects through (client credentials). Shown when adding a store and on a store whose
 * connection fails or lacks rights.
 */
export async function ShopifySetupGuide({ open = false }: { open?: boolean }) {
  const t = await getTranslations("stores.setup");
  const url = crmPublicUrl();
  return (
    <details className="rounded-lg border border-line p-3" open={open} data-testid="shopify-setup-guide">
      <summary className="cursor-pointer font-semibold text-accent">{t("title")}</summary>
      <ol className="mt-3 mb-0 flex flex-col gap-4 pl-5">
        <li>
          <p className="mt-0">{t("step1")}</p>
        </li>
        <li>
          <p className="mt-0">{t("step2")}</p>
          <div className="flex flex-col gap-3">
            <Row field="App details → App name">
              <CopyValue value="Fulfillment CRM" label="App name" />
            </Row>
            <Row field="Version name (optional)">{t("leaveEmpty")}</Row>
            <Row field="API access → Scopes">
              <CopyValue value={REQUIRED_SCOPES_TEXT} label="Scopes" />
            </Row>
            <Row field="Optional scopes">{t("leaveEmpty")}</Row>
            <Row field="Webhooks API version">
              <CopyValue value={SHOPIFY_API_VERSION} label="Webhooks API version" />
            </Row>
            <Row field="URLs → App URL">
              {url ? (
                <CopyValue value={url} label="App URL" />
              ) : (
                <span className="text-warn">{t("noUrl")}</span>
              )}
            </Row>
            <Row field="Embed app in Shopify admin">
              <strong>{t("uncheck")}</strong>
            </Row>
            <Row field="Allowed redirection URL(s)">{t("leaveEmpty")}</Row>
            <Row field="Use legacy install flow">{t("noCheck")}</Row>
            <Row field="Preferences URL (optional)">{t("leaveEmpty")}</Row>
            <Row field="Network access · POS · App proxy">{t("leaveAll")}</Row>
          </div>
          <p className="mb-0">{t("release")}</p>
        </li>
        <li>
          <p className="my-0">{t("step3")}</p>
        </li>
        <li>
          <p className="my-0">{t("step4")}</p>
        </li>
      </ol>
    </details>
  );
}

/** On a connected store: the required rights the app lacks, and how to add them. */
export async function MissingScopes({ status }: { status: unknown }) {
  const t = await getTranslations("stores.setup");
  const s = (status ?? {}) as { ok?: boolean; missingScopes?: string[] | null };
  if (!s.ok || !s.missingScopes?.length) return null;
  return (
    <div className="mt-3 rounded-lg bg-warn-bg p-3 text-sm" data-testid="missing-scopes">
      <p className="mt-0 font-semibold text-warn">{t("missingTitle", { n: s.missingScopes.length })}</p>
      <p className="my-1 font-mono text-[12px]">{s.missingScopes.join(", ")}</p>
      <p className="mb-2">{t("missingHow")}</p>
      <CopyValue value={REQUIRED_SCOPES_TEXT} label="Scopes" />
    </div>
  );
}
