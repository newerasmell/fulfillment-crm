"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createProductFromVariantAction, linkVariantAction } from "@/app/actions/products";
import { ghostButtonCls, inputCls } from "@/components/ui/form";

export function MatchVariant({
  linkId,
  suggestion,
  title,
}: {
  linkId: string;
  suggestion: string | null;
  title: string;
}) {
  const t = useTranslations("products");
  const [linkState, link, linking] = useActionState(linkVariantAction.bind(null, linkId), undefined);
  const [createState, create, creating] = useActionState(
    createProductFromVariantAction.bind(null, linkId),
    undefined,
  );
  const error = linkState?.error ?? createState?.error;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={link} className="flex items-center gap-2" aria-label={t("linkTo", { title })}>
        <input
          name="sku"
          required
          placeholder={t("masterSku")}
          aria-label={t("masterSku")}
          className={`${inputCls} min-h-10 w-40 font-mono`}
        />
        <button type="submit" disabled={linking} className={ghostButtonCls}>
          {t("link")}
        </button>
      </form>
      {suggestion && (
        <form action={create}>
          <button
            type="submit"
            disabled={creating}
            className={ghostButtonCls}
            title={t("createHint", { sku: suggestion })}
          >
            {t("create", { sku: suggestion })}
          </button>
        </form>
      )}
      {error && (
        <span role="status" className="text-sm text-block">
          {t(`errors.${error}`)}
        </span>
      )}
    </div>
  );
}
