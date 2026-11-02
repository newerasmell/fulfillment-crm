"use client";

import { useActionState, useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  createLineAction,
  setCompanyLineAction,
  setLineArchivedAction,
  updateLineAction,
} from "@/app/actions/lines";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";

const COLORS = ["rose", "slate", "brown", "olive", "ink"] as const;

export function LineError({ code }: { code?: string }) {
  const t = useTranslations("lines.errors");
  if (!code) return null;
  const known = [
    "forbidden",
    "invalid",
    "not_found",
    "line_exists",
    "connection_not_in_line",
    "product_not_found",
    "already_linked",
    "import_stale",
    "import_not_ready",
    "no_file",
    "file_too_large",
    "bad_file",
  ];
  return (
    <span role="alert" className="text-sm text-block">
      {t(known.includes(code) ? code : "invalid")}
    </span>
  );
}

function ColorSelect({ value }: { value?: string }) {
  const t = useTranslations("lines");
  return (
    <select name="color" defaultValue={value ?? "rose"} aria-label={t("color")} className={inputCls}>
      {COLORS.map((c) => (
        <option key={c} value={c}>
          {t(`colors.${c}`)}
        </option>
      ))}
    </select>
  );
}

export function NewLineForm() {
  const t = useTranslations("lines");
  const [state, action, pending] = useActionState(createLineAction, undefined);
  return (
    <form action={action} className="mt-4 flex flex-wrap items-end gap-3" aria-label={t("newLine")}>
      <label className={labelCls}>
        {t("lineName")}
        <input name="name" required minLength={2} maxLength={80} className={`${inputCls} w-56`} />
      </label>
      <label className={labelCls}>
        {t("color")}
        <ColorSelect />
      </label>
      <label className={labelCls}>
        {t("sortOrder")}
        <input name="sortOrder" type="number" min={0} defaultValue={0} className={`${inputCls} w-24`} />
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {t("addLine")}
      </button>
      {state?.ok && (
        <span role="status" className="text-sm text-ok">
          {t("saved")}
        </span>
      )}
      <LineError code={state?.error} />
    </form>
  );
}

export function EditLineForm({
  line,
}: {
  line: { id: string; name: string; color: string; sortOrder: number; archived: boolean };
}) {
  const t = useTranslations("lines");
  const [state, action, pending] = useActionState(updateLineAction.bind(null, line.id), undefined);
  const [archiving, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form
        action={action}
        className="flex flex-wrap items-center gap-2"
        aria-label={t("editLine", { name: line.name })}
      >
        <input
          name="name"
          defaultValue={line.name}
          required
          minLength={2}
          aria-label={t("lineName")}
          className={`${inputCls} w-44`}
        />
        <ColorSelect value={line.color} />
        <input
          name="sortOrder"
          type="number"
          min={0}
          defaultValue={line.sortOrder}
          aria-label={t("sortOrder")}
          className={`${inputCls} w-20`}
        />
        <button type="submit" disabled={pending} className={ghostButtonCls}>
          {t("save")}
        </button>
      </form>
      <button
        type="button"
        disabled={archiving}
        onClick={() => start(() => setLineArchivedAction(line.id, !line.archived))}
        className={ghostButtonCls}
      >
        {line.archived ? t("unarchive") : t("archive")}
      </button>
      {state?.ok && (
        <span role="status" className="text-sm text-ok">
          {t("saved")}
        </span>
      )}
      <LineError code={state?.error} />
    </div>
  );
}

export function CompanyLineForm({
  company,
  lines,
}: {
  company: { id: string; name: string; lineId: string | null };
  lines: { id: string; name: string }[];
}) {
  const t = useTranslations("lines");
  const [state, action, pending] = useActionState(setCompanyLineAction.bind(null, company.id), undefined);
  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2"
      aria-label={t("companyLine", { name: company.name })}
    >
      <select
        name="lineId"
        defaultValue={company.lineId ?? ""}
        aria-label={t("lineOf", { name: company.name })}
        className={inputCls}
      >
        <option value="">{t("noLine")}</option>
        {lines.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={ghostButtonCls}>
        {t("save")}
      </button>
      {state?.ok && (
        <span role="status" className="text-sm text-ok">
          {t("saved")}
        </span>
      )}
      <LineError code={state?.error} />
    </form>
  );
}
