"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import {
  createManualAction,
  manualStockAction,
  searchManualProductsAction,
  officesAction,
  previewManualAction,
  quoteAction,
  quoteStatusAction,
  orderDraftForManualAction,
  searchOrdersForManualAction,
} from "@/app/actions/labels";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";
import type { Finding } from "@/server/checks/findings";
import type {
  ManualPreview,
  ManualShipmentInput,
  ReplacementDraft,
  ReplacementReason,
} from "@/server/labels";
import type { ProductStock } from "@/server/labels/stock-view";
import type { ManualOrderDraft } from "@/server/labels/replacement";

const REASONS: ReplacementReason[] = ["damaged", "missing_item", "wrong_item", "lost", "other"];

/**
 * Ръчна пратка (P7-03). The form never decides what may be sent: "Провери" runs the server-side validators
 * (the same as for every order) and shows the routing explanation and the exact payload; "Създай" re-validates on
 * the server, and only the warnings shown here can be acknowledged. One submission id per form → a double click
 * creates one shipment. Label-only kinds then wait in the outbox under the connection's mode.
 */

type Kind = ManualShipmentInput["kind"];
interface Conn {
  id: string;
  name: string;
  type: "FHB_V3" | "FHB_JOY" | "EUSHIPMENTS";
  liveMode: string;
  companyId: string | null;
  parcelServices: string[];
  pickupServices: string[];
}
interface Courier {
  courierId: number;
  name: string;
  toOffice: boolean;
  country: string | null;
}
type Office = Awaited<ReturnType<typeof officesAction>>[number];

const KINDS: Kind[] = ["JOY_LABEL", "AWB", "PRE_AWB", "WAREHOUSE"];
const TYPES: Record<Kind, Conn["type"][]> = {
  WAREHOUSE: ["FHB_V3", "EUSHIPMENTS"],
  JOY_LABEL: ["FHB_JOY"],
  AWB: ["EUSHIPMENTS"],
  PRE_AWB: ["EUSHIPMENTS"],
};
const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));
/**
 * One id per submission (the server refuses a create without one). crypto.randomUUID exists only in secure
 * contexts; getRandomValues works everywhere, so the id — and the double-click protection — is never missing.
 */
const uuid = (): string => {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export function ManualForm(props: {
  companies: { id: string; name: string }[];
  defaultCompanyId: string;
  connections: Conn[];
  couriers: Record<string, Courier[]>;
  products: { id: string; sku: string; name: string }[];
  /** „Изпрати замяна“: the form starts from this order (free: price 0, no COD), every field still editable. */
  replacement?: ReplacementDraft | null;
  /** The usual destination country of each company (its stores' first country): the form's default. */
  companyCountries?: Record<string, string>;
}) {
  const draft = props.replacement ?? null;
  const t = useTranslations("manual");
  const tm = useTranslations("mode");
  const locale = useLocale();
  const router = useRouter();
  const [kind, setKind] = useState<Kind>(draft ? "WAREHOUSE" : "JOY_LABEL");
  const [companyId, setCompanyId] = useState(draft?.companyId ?? props.defaultCompanyId);
  const [reason, setReason] = useState<ReplacementReason | "">("");
  const [shopifyRef, setShopifyRef] = useState("");
  const [stock, setStock] = useState<Record<string, ProductStock>>({});
  const [reasonText, setReasonText] = useState("");
  const options = props.connections.filter((c) => TYPES[kind].includes(c.type));
  const [connectionId, setConnectionId] = useState(options[0]?.id ?? "");
  const conn = options.find((c) => c.id === connectionId) ?? options[0] ?? null;
  const [r, setR] = useState(
    draft?.recipient ?? {
      name: "",
      email: "",
      phone: "",
      address1: "",
      buildingNumber: "",
      address2: "",
      city: "",
      zip: "",
      region: "",
      countryCode: props.companyCountries?.[draft?.companyId ?? props.defaultCompanyId] ?? "BG",
    },
  );
  // The country follows the company until a person types one or picks an order.
  const [countryTouched, setCountryTouched] = useState(!!draft);
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedNotes, setPickedNotes] = useState<{
    unmatched: string[];
    pricesCleared: boolean;
    live: ManualOrderDraft["liveShipment"];
  } | null>(null);
  const applyOrder = (d: ManualOrderDraft) => {
    if (d.companyId) setCompanyId(d.companyId);
    setR({ ...d.recipient });
    setCountryTouched(true);
    setShopifyRef(d.shopifyNumber);
    setCurrency(d.cod?.currency ?? d.currency);
    setCod(d.cod ? d.cod.amount : "");
    // Always replaced (never the previous order's lines left behind); unmatched lines are named below.
    setLines(
      d.lines.length
        ? d.lines.map((l) => ({
            uid: uuid(),
            productId: l.productId,
            quantity: String(l.quantity),
            unitPrice: l.unitPrice,
          }))
        : [{ uid: uuid(), productId: "", quantity: "1", unitPrice: "" }],
    );
    setLabels((prev) => ({
      ...prev,
      ...Object.fromEntries(d.lines.map((l) => [l.productId, { id: l.productId, sku: l.sku, name: l.name }])),
    }));
    setPicked(d.shopifyNumber);
    setPickedNotes({ unmatched: d.unmatched, pricesCleared: d.pricesCleared, live: d.liveShipment });
    setPreview(null);
    setFindings([]);
  };
  const [cod, setCod] = useState("");
  // Required recipient fields light up in red after the first Провери / Създай (owner request 2026-11-24).
  const [attempted, setAttempted] = useState(false);
  const [currency, setCurrency] = useState(draft?.currency ?? "EUR");
  const [parcels, setParcels] = useState("1");
  const [weight, setWeight] = useState("1");
  const [parcelService, setParcelService] = useState("");
  const [deliveryPoint, setDeliveryPoint] = useState("");
  const [courierId, setCourierId] = useState("");
  const [office, setOffice] = useState<Office | null>(null);
  const [officeQ, setOfficeQ] = useState("");
  const [offices, setOffices] = useState<Office[]>([]);
  const [waybillDate, setWaybillDate] = useState("");
  const [contents, setContents] = useState("");
  const [note, setNote] = useState("");
  const [declared, setDeclared] = useState("");
  // Each line has its own id: removing one never hands its picker to the next line.
  const [lines, setLines] = useState<
    { uid: string; productId: string; quantity: string; unitPrice: string }[]
  >(() =>
    draft?.lines.length
      ? draft.lines.map((l) => ({
          uid: uuid(),
          productId: l.productId,
          quantity: String(l.quantity),
          unitPrice: "0",
        }))
      : [{ uid: uuid(), productId: "", quantity: "1", unitPrice: "" }],
  );
  // The label of every product chosen so far (the picker always shows the line's own product).
  const [labels, setLabels] = useState<Record<string, Pick>>(() =>
    Object.fromEntries(props.products.map((p) => [p.id, p])),
  );
  // Stock per warehouse of the chosen products (quick check while filling the form).
  const productKey = [...new Set(lines.map((l) => l.productId).filter(Boolean))].sort().join(",");
  useEffect(() => {
    if (kind !== "WAREHOUSE" || !productKey) return;
    let live = true;
    void manualStockAction(productKey.split(",")).then((res) => {
      if (!live || "error" in res) return;
      setStock((prev) => ({ ...prev, ...Object.fromEntries(res.map((p) => [p.productId, p])) }));
    });
    return () => {
      live = false;
    };
  }, [kind, productKey]);
  const [preview, setPreview] = useState<ManualPreview | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string>(() => uuid());
  const [pending, start] = useTransition();

  const input = ((): ManualShipmentInput => {
    const p = Math.max(1, Math.trunc(Number(parcels) || 1));
    const w = num(weight);
    return {
      kind,
      companyId,
      connectionId: conn?.id ?? "",
      recipient: {
        name: r.name,
        email: r.email || null,
        phone: r.phone,
        address1: r.address1,
        buildingNumber: r.buildingNumber || null,
        address2: r.address2 || null,
        city: r.city,
        zip: r.zip,
        region: r.region || null,
        countryCode: r.countryCode,
      },
      cod: num(cod),
      currency,
      parcels: p,
      ...(kind === "JOY_LABEL"
        ? { weights: w ? Array.from({ length: p }, () => w) : null }
        : { totalWeight: w }),
      declaredValue: num(declared),
      contents: contents || null,
      note: note || null,
      parcelService: parcelService || null,
      deliveryPoint: deliveryPoint || null,
      courierId: courierId ? Number(courierId) : null,
      officeId: office?.officeId ?? null,
      waybillDate: waybillDate || null,
      lines:
        kind === "WAREHOUSE"
          ? lines
              .filter((l) => l.productId)
              .map((l) => ({
                productId: l.productId,
                quantity: Math.max(1, Math.trunc(Number(l.quantity) || 1)),
                unitPrice: num(l.unitPrice),
              }))
          : [],
      shopifyOrderNumber: draft ? null : shopifyRef.trim() || null,
      replacement:
        draft && reason
          ? { sourceOrderId: draft.sourceOrderId, reason, reasonText: reasonText.trim() || null }
          : null,
      clientRequestId: requestId,
    };
  })();
  // A replacement needs its reason before it can be checked or created.
  const reasonMissing = !!draft && (!reason || (reason === "other" && !reasonText.trim()));
  // Without these no parcel can go out (owner request 2026-11-24): name, phone, country, street, city, postcode.
  const REQUIRED = ["name", "phone", "countryCode", "address1", "city", "zip"] as const;
  const missing = REQUIRED.filter((k) => !String(r[k] ?? "").trim());
  const bad = (k: (typeof REQUIRED)[number]) => attempted && missing.includes(k);
  const reqCls = (k: (typeof REQUIRED)[number]) => (bad(k) ? " !border-block bg-block-bg" : "");
  const codZero = !(Number(num(cod) ?? 0) > 0);
  const missingError = () => {
    setAttempted(true);
    if (!missing.length) return false;
    setError(t("form.missingRequired", { fields: missing.map((k) => t(`form.req.${k}`)).join(", ") }));
    return true;
  };

  const msg = (f: Finding) => (locale === "en" ? f.message_en : f.message_bg);
  const errText = (code: string) => (t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.generic"));
  const invalidate = () => {
    setPreview(null);
    setFindings([]);
  };
  const set = (k: keyof typeof r) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setR((x) => ({ ...x, [k]: e.target.value }));
    invalidate();
  };

  const check = () =>
    start(async () => {
      setError(null);
      if (missingError()) return;
      const res = await previewManualAction(input);
      if ("error" in res) {
        setError(errText(res.error));
        return;
      }
      setPreview(res);
      setFindings(res.findings);
    });
  const create = () =>
    start(async () => {
      setError(null);
      if (missingError()) return;
      if (reasonMissing) return setError(t("replacement.reasonRequired"));
      // A parcel without cash on delivery is allowed, but never by oversight (owner request 2026-11-24).
      if (codZero && !window.confirm(t("form.codZeroConfirm"))) return;
      const soft = findings.filter((f) => f.severity === "soft").map((f) => f.code);
      const res = await createManualAction({ ...input, acknowledgedCodes: soft });
      if ("error" in res) {
        if (res.findings) setFindings(res.findings);
        setError(errText(res.error));
        if (res.error !== "manual_preflight_needs_ack" && res.error !== "manual_preflight_failed")
          setRequestId(uuid());
        return;
      }
      router.push(
        res.kind === "WAREHOUSE" ? `/orders/${res.orderId}` : `/manual-shipments/${res.manualShipmentId}`,
      );
    });
  const searchOffices = () =>
    start(async () => {
      if (!conn || !courierId) return;
      setOffices(await officesAction(conn.id, Number(courierId), officeQ));
    });
  const askQuote = () =>
    start(async () => {
      if (!conn || !courierId) return;
      setQuote(t("form.quoteWaiting"));
      const q = await quoteAction({
        connectionId: conn.id,
        courierId: Number(courierId),
        weight: num(weight) ?? 1,
        codAmount: num(cod) ?? 0,
        toOffice: !!office,
        currency,
      });
      if ("error" in q) return setQuote(errText(q.error));
      for (let i = 0; i < 15; i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const res = await quoteStatusAction(q.quoteId);
        if (!("quote" in res)) return setQuote(errText(res.error));
        const s = res.quote;
        if (s.status === "DONE") {
          const p = (s.response as { price?: string } | null)?.price;
          return setQuote(t("form.quoteResult", { price: p ?? "?" }));
        }
        if (s.status === "NO_PRICE") return setQuote(t("form.quoteNone"));
        if (s.status === "FAILED") return setQuote(t("form.quoteFailed", { error: s.error ?? "" }));
      }
      setQuote(t("form.quoteSlow"));
    });

  const hard = findings.some((f) => f.severity === "hard");
  const eu = kind === "AWB" || kind === "PRE_AWB";
  const couriers = conn ? (props.couriers[conn.id] ?? []) : [];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <form
        className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5"
        aria-label={t("form.title")}
        // Our own check marks the missing fields in red (the browser's would stop at the first one silently).
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (reasonMissing) return setError(t("replacement.reasonRequired"));
          check();
        }}
      >
        {!draft && <ShopifyOrderPicker picked={picked} onPick={applyOrder} />}
        {!draft && pickedNotes && (
          <div className="flex flex-col gap-1 text-sm" data-testid="manual-pick-notes">
            {pickedNotes.live && (
              <p className="m-0 rounded-[10px] bg-warn-bg p-2 text-warn" role="alert">
                {t("pickOrder.live", {
                  warehouse: pickedNotes.live.warehouse ?? "—",
                  ref: pickedNotes.live.externalId ?? "—",
                  status: pickedNotes.live.status,
                })}
              </p>
            )}
            {pickedNotes.unmatched.length > 0 && (
              <p className="m-0 text-warn">
                {t("replacement.unmatched", { items: pickedNotes.unmatched.join(", ") })}
              </p>
            )}
            {pickedNotes.pricesCleared && <p className="m-0 text-muted">{t("pickOrder.pricesCleared")}</p>}
          </div>
        )}
        {!draft && (
          <label className={labelCls}>
            <span>{t("form.shopifyOrderNumber")}</span>
            <input
              className={inputCls}
              value={shopifyRef}
              maxLength={40}
              placeholder={t("form.shopifyOrderNumberPlaceholder")}
              data-testid="manual-shopify-number"
              onChange={(e) => setShopifyRef(e.target.value)}
            />
            <span className="text-xs font-normal text-muted">{t("form.shopifyOrderNumberHint")}</span>
          </label>
        )}
        {draft && (
          <div
            className="flex flex-col gap-2 rounded-[10px] border border-accent bg-accent-soft p-3 text-sm"
            data-testid="replacement-banner"
          >
            <strong>{t("replacement.title", { number: draft.sourceNumber })}</strong>
            <span className="text-muted">{t("replacement.hint")}</span>
            {draft.unmatched.length > 0 && (
              <span className="text-warn">
                {t("replacement.unmatched", { items: draft.unmatched.join(", ") })}
              </span>
            )}
            <label className={labelCls}>
              <span>{t("replacement.reason")}</span>
              <select
                className={inputCls}
                value={reason}
                data-testid="replacement-reason"
                onChange={(e) => {
                  setReason(e.target.value as ReplacementReason | "");
                  invalidate();
                }}
              >
                <option value="">{t("replacement.pick")}</option>
                {REASONS.map((x) => (
                  <option key={x} value={x}>
                    {t(`replacement.reasons.${x}`)}
                  </option>
                ))}
              </select>
            </label>
            {reason === "other" && (
              <input
                className={inputCls}
                value={reasonText}
                maxLength={300}
                placeholder={t("replacement.reasonText")}
                data-testid="replacement-reason-text"
                onChange={(e) => setReasonText(e.target.value)}
              />
            )}
          </div>
        )}
        <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
          <legend className="mb-2 text-[13px] font-semibold">{t("form.kind")}</legend>
          {KINDS.map((k) => (
            <label
              key={k}
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-[10px] border px-3 ${k === kind ? "border-accent bg-accent-soft font-semibold" : "border-line"}`}
            >
              <input
                type="radio"
                name="kind"
                value={k}
                checked={k === kind}
                onChange={() => {
                  setKind(k);
                  setConnectionId(props.connections.find((c) => TYPES[k].includes(c.type))?.id ?? "");
                  invalidate();
                }}
              />
              {t(`kind.${k}`)}
            </label>
          ))}
          <p className="m-0 w-full text-sm text-muted">{t(`kindHint.${kind}`)}</p>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            {t("form.company")}
            <select
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                const c = props.companyCountries?.[e.target.value];
                if (!countryTouched && c) setR((x) => ({ ...x, countryCode: c }));
                invalidate();
              }}
              className={inputCls}
            >
              {props.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            {t("form.connection")}
            <select
              value={conn?.id ?? ""}
              onChange={(e) => (setConnectionId(e.target.value), invalidate())}
              className={inputCls}
              required
            >
              {options.length === 0 && <option value="">{t("form.noConnection")}</option>}
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {tm(c.liveMode)}
                </option>
              ))}
            </select>
            {conn && (
              <span className="text-xs font-normal text-muted">{t(`form.modeHint.${conn.liveMode}`)}</span>
            )}
          </label>
        </div>

        <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-2">
          <legend className="mb-2 text-[13px] font-semibold">{t("form.recipient")}</legend>
          <label className={labelCls}>
            <Req>{t("form.name")}</Req>
            <input
              value={r.name}
              onChange={set("name")}
              required
              aria-invalid={bad("name") || undefined}
              // The visible "*" is not part of the field's name.
              aria-label={t("form.name")}
              maxLength={100}
              className={inputCls + reqCls("name")}
            />
          </label>
          <label className={labelCls}>
            <Req>{t("form.phone")}</Req>
            <input
              value={r.phone}
              onChange={set("phone")}
              required
              aria-invalid={bad("phone") || undefined}
              // The visible "*" is not part of the field's name.
              aria-label={t("form.phone")}
              maxLength={40}
              className={`${inputCls} font-mono${reqCls("phone")}`}
            />
          </label>
          <label className={labelCls}>
            <Req>{t("form.country")}</Req>
            <input
              value={r.countryCode}
              onChange={(e) => (setCountryTouched(true), set("countryCode")(e))}
              required
              aria-invalid={bad("countryCode") || undefined}
              // The visible "*" is not part of the field's name.
              aria-label={t("form.country")}
              maxLength={2}
              className={`${inputCls} w-24 font-mono uppercase${reqCls("countryCode")}`}
            />
          </label>
          <label className={labelCls}>
            <Req>{t("form.street")}</Req>
            <input
              value={r.address1}
              onChange={set("address1")}
              required
              aria-invalid={bad("address1") || undefined}
              // The visible "*" is not part of the field's name.
              aria-label={t("form.street")}
              maxLength={200}
              className={inputCls + reqCls("address1")}
            />
          </label>
          <label className={labelCls}>
            <Req>{t("form.city")}</Req>
            <input
              value={r.city}
              onChange={set("city")}
              required
              aria-invalid={bad("city") || undefined}
              // The visible "*" is not part of the field's name.
              aria-label={t("form.city")}
              maxLength={100}
              className={inputCls + reqCls("city")}
            />
          </label>
          <label className={labelCls}>
            <Req>{t("form.zip")}</Req>
            <input
              value={r.zip}
              onChange={set("zip")}
              required
              aria-invalid={bad("zip") || undefined}
              // The visible "*" is not part of the field's name.
              aria-label={t("form.zip")}
              maxLength={15}
              className={`${inputCls} font-mono${reqCls("zip")}`}
            />
          </label>
          {/* Optional fields last (owner request 2026-11-24): the required ones above are what a parcel needs. */}
          <p className="m-0 border-t border-line pt-2 text-xs font-semibold text-muted sm:col-span-2">
            {t("form.optional")}
          </p>
          <label className={labelCls}>
            {t("form.email")}
            <input
              value={r.email}
              onChange={set("email")}
              type="email"
              maxLength={100}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            {t("form.building")}
            <input
              value={r.buildingNumber}
              onChange={set("buildingNumber")}
              maxLength={40}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            {t("form.address2")}
            <input value={r.address2} onChange={set("address2")} maxLength={200} className={inputCls} />
          </label>
          {eu && (
            <label className={labelCls}>
              {t("form.region")}
              <input value={r.region} onChange={set("region")} maxLength={100} className={inputCls} />
            </label>
          )}
        </fieldset>

        <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-3">
          <legend className="mb-2 text-[13px] font-semibold">{t("form.parcel")}</legend>
          <label className={labelCls}>
            {t("form.parcels")}
            <input
              value={parcels}
              onChange={(e) => (setParcels(e.target.value), invalidate())}
              inputMode="numeric"
              className={`${inputCls} font-mono`}
            />
          </label>
          <label className={labelCls}>
            {kind === "JOY_LABEL" ? t("form.weightEach") : t("form.weightTotal")}
            <input
              value={weight}
              onChange={(e) => (setWeight(e.target.value), invalidate())}
              inputMode="decimal"
              className={`${inputCls} font-mono`}
            />
          </label>
          <label
            className={`${labelCls} rounded-[10px] border-2 p-2 ${codZero ? "border-block bg-block-bg" : "border-ok bg-ok-bg"}`}
            data-testid="manual-cod"
          >
            <span className="font-semibold">{t("form.cod")}</span>
            <span className="flex gap-2">
              <input
                value={cod}
                onChange={(e) => (setCod(e.target.value), invalidate())}
                inputMode="decimal"
                className={`${inputCls} w-full font-mono`}
              />
              <input
                value={currency}
                onChange={(e) => (setCurrency(e.target.value.toUpperCase()), invalidate())}
                maxLength={3}
                aria-label={t("form.currency")}
                className={`${inputCls} w-20 font-mono`}
              />
            </span>
            <span className={`text-xs font-normal ${codZero ? "font-semibold text-block" : "text-muted"}`}>
              {codZero ? t("form.codZeroHint") : t("form.codHint")}
            </span>
          </label>
          {eu && (
            <label className={labelCls}>
              {t("form.declared")}
              <input
                value={declared}
                onChange={(e) => (setDeclared(e.target.value), invalidate())}
                inputMode="decimal"
                className={`${inputCls} font-mono`}
              />
            </label>
          )}
        </fieldset>

        {kind === "JOY_LABEL" && conn && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              {t("form.parcelService")}
              {conn.parcelServices.length ? (
                <select
                  value={parcelService}
                  onChange={(e) => (setParcelService(e.target.value), invalidate())}
                  className={`${inputCls} font-mono`}
                >
                  <option value="">—</option>
                  {conn.parcelServices.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={parcelService}
                  onChange={(e) => (setParcelService(e.target.value), invalidate())}
                  className={`${inputCls} font-mono`}
                />
              )}
            </label>
            <label className={labelCls}>
              {t("form.deliveryPoint")}
              <input
                value={deliveryPoint}
                onChange={(e) => (setDeliveryPoint(e.target.value), invalidate())}
                className={`${inputCls} font-mono`}
              />
              {conn.pickupServices.includes(parcelService) && (
                <span className="text-xs font-normal text-warn">{t("form.deliveryPointRequired")}</span>
              )}
            </label>
          </div>
        )}

        {eu && conn && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              {t("form.courier")}
              <select
                value={courierId}
                onChange={(e) => (
                  setCourierId(e.target.value),
                  setOffice(null),
                  setOffices([]),
                  invalidate()
                )}
                className={inputCls}
              >
                <option value="">{kind === "PRE_AWB" ? t("form.courierAuto") : "—"}</option>
                {couriers.map((c) => (
                  <option key={c.courierId} value={c.courierId}>
                    {c.name}
                    {c.country ? ` · ${c.country}` : ""}
                  </option>
                ))}
              </select>
              {couriers.length === 0 && (
                <span className="text-xs font-normal text-muted">{t("form.noCouriers")}</span>
              )}
            </label>
            <label className={labelCls}>
              {t("form.waybillDate")}
              <input
                type="date"
                value={waybillDate}
                onChange={(e) => (setWaybillDate(e.target.value), invalidate())}
                className={inputCls}
              />
              <span className="text-xs font-normal text-muted">{t("form.waybillDateHint")}</span>
            </label>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-[13px] font-medium">{t("form.office")}</span>
              {office ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="rounded-lg bg-eu-chip px-2 py-1 text-sm text-eu-text">
                    {office.name} · {office.cityName} {office.address}
                  </span>
                  <button
                    type="button"
                    className={ghostButtonCls}
                    onClick={() => (setOffice(null), invalidate())}
                  >
                    {t("form.officeClear")}
                  </button>
                </span>
              ) : (
                <span className="flex flex-wrap gap-2">
                  <input
                    value={officeQ}
                    onChange={(e) => setOfficeQ(e.target.value)}
                    placeholder={t("form.officeSearch")}
                    aria-label={t("form.officeSearch")}
                    className={`${inputCls} w-64`}
                  />
                  <button
                    type="button"
                    className={ghostButtonCls}
                    disabled={!courierId || pending}
                    onClick={searchOffices}
                  >
                    {t("form.officeFind")}
                  </button>
                </span>
              )}
              {!office && offices.length > 0 && (
                <ul className="m-0 max-h-48 list-none overflow-y-auto rounded-lg border border-line p-1">
                  {offices.map((o) => (
                    <li key={o.officeId}>
                      <button
                        type="button"
                        className="min-h-10 w-full rounded px-2 text-left hover:bg-hover"
                        onClick={() => (setOffice(o), invalidate())}
                      >
                        {o.name} · {o.cityName} {o.address}{" "}
                        <span className="font-mono text-xs text-muted">{o.code}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {kind === "AWB" && (
              <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <button
                  type="button"
                  className={ghostButtonCls}
                  disabled={!courierId || pending}
                  onClick={askQuote}
                >
                  {t("form.quote")}
                </button>
                {quote && (
                  <span role="status" className="text-sm">
                    {quote}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {kind === "WAREHOUSE" && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-[13px] font-semibold">{t("form.products")}</legend>
            {lines.map((l) => (
              <div key={l.uid} className="flex flex-wrap items-end gap-2">
                <ProductPicker
                  label={t("form.product")}
                  selected={l.productId ? (labels[l.productId] ?? null) : null}
                  onPick={(p) => (
                    setLabels((x) => ({ ...x, [p.id]: p })),
                    setLines((ls) => ls.map((x) => (x.uid === l.uid ? { ...x, productId: p.id } : x))),
                    invalidate()
                  )}
                />
                <label className={labelCls}>
                  {t("form.qty")}
                  <input
                    value={l.quantity}
                    inputMode="numeric"
                    onChange={(e) => (
                      setLines((ls) =>
                        ls.map((x) => (x.uid === l.uid ? { ...x, quantity: e.target.value } : x)),
                      ),
                      invalidate()
                    )}
                    className={`${inputCls} w-20 font-mono`}
                  />
                </label>
                <label className={labelCls}>
                  {t("form.price")}
                  <input
                    value={l.unitPrice}
                    inputMode="decimal"
                    onChange={(e) => (
                      setLines((ls) =>
                        ls.map((x) => (x.uid === l.uid ? { ...x, unitPrice: e.target.value } : x)),
                      ),
                      invalidate()
                    )}
                    className={`${inputCls} w-28 font-mono`}
                  />
                </label>
                {lines.length > 1 && (
                  <button
                    type="button"
                    className={ghostButtonCls}
                    onClick={() => (setLines((ls) => ls.filter((x) => x.uid !== l.uid)), invalidate())}
                  >
                    {t("form.removeLine")}
                  </button>
                )}
                {l.productId && stock[l.productId] && <StockPerWarehouse s={stock[l.productId]!} />}
              </div>
            ))}
            <button
              type="button"
              className={`${ghostButtonCls} self-start`}
              onClick={() =>
                setLines((ls) => [...ls, { uid: uuid(), productId: "", quantity: "1", unitPrice: "" }])
              }
            >
              {t("form.addLine")}
            </button>
          </fieldset>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {kind !== "JOY_LABEL" && (
            <label className={labelCls}>
              {t("form.contents")}
              <input
                value={contents}
                onChange={(e) => (setContents(e.target.value), invalidate())}
                maxLength={1000}
                className={inputCls}
              />
            </label>
          )}
          <label className={labelCls}>
            {t("form.note")}
            <input
              value={note}
              onChange={(e) => (setNote(e.target.value), invalidate())}
              maxLength={eu ? 100 : 250}
              className={inputCls}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending || !conn} className={ghostButtonCls}>
            {t("form.check")}
          </button>
          <button
            type="button"
            onClick={create}
            disabled={pending || !conn || !preview || hard}
            className={buttonCls}
          >
            {kind === "WAREHOUSE" ? t("form.createOrder") : t("form.createLabel")}
          </button>
          {!preview && <span className="text-sm text-muted">{t("form.checkFirst")}</span>}
          {error && (
            <span role="alert" className="text-block">
              {error}
            </span>
          )}
        </div>
      </form>

      <aside className="flex flex-col gap-4" aria-label={t("form.checksTitle")}>
        <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
          <h2 className="mt-0 text-base font-semibold">{t("form.checksTitle")}</h2>
          {!preview && findings.length === 0 ? (
            <p className="m-0 text-sm text-muted">{t("form.checksEmpty")}</p>
          ) : findings.length === 0 ? (
            <p className="m-0 rounded-lg bg-ok-bg px-3 py-2 text-ok">{t("form.checksOk")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {findings.map((f) => (
                <li
                  key={f.code}
                  className={`rounded-lg px-3 py-2 text-sm ${f.severity === "hard" ? "bg-block-bg text-block" : "bg-warn-bg text-warn"}`}
                >
                  <strong>{f.severity === "hard" ? t("form.hard") : t("form.soft")}:</strong> {msg(f)}
                  <span className="ml-1 font-mono text-xs opacity-80">{f.code}</span>
                </li>
              ))}
            </ul>
          )}
          {findings.some((f) => f.severity === "soft") && !hard && (
            <p className="mb-0 text-sm text-muted">{t("form.ackHint")}</p>
          )}
        </section>
        {preview && (
          <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <h2 className="mt-0 text-base font-semibold">{t("form.routingTitle")}</h2>
            <p className="m-0 text-sm">{locale === "en" ? preview.explanation.en : preview.explanation.bg}</p>
            {preview.stock && (
              <p className="mb-0 text-sm text-muted">
                {t("form.stock")}: {t(`form.stockStatus.${preview.stock.status}`)}
              </p>
            )}
            {preview.payload != null && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold">{t("form.payload")}</summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-hover p-2 font-mono text-xs">
                  {JSON.stringify(preview.payload, null, 2)}
                </pre>
              </details>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}

/** The chosen product's units in every warehouse and in total (quick check, owner request 2026-11-23). */
function StockPerWarehouse({ s }: { s: ProductStock }) {
  const t = useTranslations("manual.stock");
  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 text-xs" data-testid="manual-stock">
      {s.warehouses.length === 0 ? (
        <span className="text-warn">{t("none")}</span>
      ) : (
        <>
          {s.warehouses.map((w) =>
            w.carried ? (
              <span
                key={w.connectionId}
                title={t("hint")}
                className={`rounded-full px-2 py-0.5 ${w.sellable > 0 ? "bg-ok-bg text-ok" : w.physical > 0 ? "bg-warn-bg text-warn" : "bg-block-bg text-block"}`}
              >
                {w.name}: <strong>{w.physical}</strong> {t("units")}
                {w.sellable !== w.physical && ` (${t("free", { n: w.sellable })})`}
                {w.stale && ` · ${t("stale")}`}
              </span>
            ) : null,
          )}
          <span className="font-semibold" data-testid="manual-stock-total">
            {t("total", { n: s.totalPhysical, free: s.totalSellable })}
          </span>
        </>
      )}
    </div>
  );
}

type Pick = { id: string; sku: string; name: string };

/**
 * Product search (owner request 2026-11-23): type a SKU, part of the name or the warehouse's code; the matches of the
 * whole catalogue appear below. Replaces a list of thousands to scroll through.
 */
function ProductPicker({
  label,
  selected,
  onPick,
}: {
  label: string;
  /** The line's product (owned by the form, so what is shown is always what is sent). */
  selected: Pick | null;
  onPick: (p: Pick) => void;
}) {
  const t = useTranslations("manual.picker");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ term: string; hits: Pick[]; failed: boolean }>({
    term: "",
    hits: [],
    failed: false,
  });
  const [active, setActive] = useState(0);
  const listId = useId();
  const term = q.trim();
  const searching = open && term.length >= 2;
  // Only the answer for what is typed now is shown; anything else is still on its way.
  const answered = searching && result.term === term;
  const hits = answered ? result.hits : [];
  useEffect(() => {
    if (!searching) return;
    let live = true;
    const timer = setTimeout(() => {
      void searchManualProductsAction(term)
        .then((res) => {
          if (!live) return;
          setResult({ term, hits: "error" in res ? [] : res, failed: "error" in res });
          setActive(0);
        })
        .catch(() => {
          if (live) setResult({ term, hits: [], failed: true });
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [searching, term]);
  const choose = (p: Pick) => {
    setQ("");
    setOpen(false);
    onPick(p);
  };
  const optionId = (idx: number) => `${listId}-${idx}`;
  return (
    <div className="relative flex min-w-64 flex-1 flex-col gap-1 text-[13px] font-medium">
      <span>{label}</span>
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={searching}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={hits[active] ? optionId(active) : undefined}
        className={inputCls}
        value={open ? q : selected ? `${selected.sku} · ${selected.name}` : ""}
        placeholder={t("placeholder")}
        data-testid="product-picker"
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setOpen(true);
          setQ(e.target.value);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.max(0, Math.min(a + 1, hits.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && hits[active]) {
            e.preventDefault();
            choose(hits[active]!);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={label}
        hidden={!searching}
        className="absolute top-full z-20 mt-1 max-h-72 w-full overflow-auto rounded-[10px] border border-line bg-surface p-1 shadow-lg"
      >
        {hits.map((p, idx) => (
          <li
            key={p.id}
            id={optionId(idx)}
            role="option"
            aria-selected={idx === active}
            className={`cursor-pointer rounded-lg px-3 py-2 font-normal ${idx === active ? "bg-accent-soft" : "hover:bg-hover"}`}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(p);
            }}
          >
            <span className="font-mono text-[12px]">{p.sku}</span> · {p.name}
          </li>
        ))}
      </ul>
      {searching && hits.length === 0 && (
        <span role="status" aria-live="polite" className="text-xs font-normal text-muted">
          {!answered ? t("searching") : result.failed ? t("failed") : t("none")}
        </span>
      )}
    </div>
  );
}

/** A required field's label: the text and a red asterisk. */
function Req({ children }: { children: React.ReactNode }) {
  return (
    <span>
      {children}
      <span className="text-block" aria-hidden>
        {" "}
        *
      </span>
    </span>
  );
}

/**
 * „Поръчка от Shopify“ (owner request 2026-11-24): search an order by number or customer and fill the form from it.
 */
function ShopifyOrderPicker({
  picked,
  onPick,
}: {
  picked: string | null;
  onPick: (d: ManualOrderDraft) => void;
}) {
  const t = useTranslations("manual.pickOrder");
  const tStatus = useTranslations("orderStatus");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Awaited<ReturnType<typeof searchOrdersForManualAction>>>([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Only the answer to the latest search is shown (a slow earlier one never overwrites it).
  const seq = useRef(0);
  useEffect(() => {
    if (q.trim().length < 2) return;
    const mine = ++seq.current;
    const id = setTimeout(
      () =>
        start(async () => {
          const rows = await searchOrdersForManualAction(q);
          if (mine !== seq.current) return;
          setFound(rows);
          setSearched(true);
        }),
      250,
    );
    return () => clearTimeout(id);
  }, [q]);
  return (
    <section
      className="flex flex-col gap-2 rounded-[10px] border border-line p-3 text-sm"
      aria-label={t("title")}
      data-testid="manual-pick-order"
    >
      <strong>{t("title")}</strong>
      <span className="text-xs text-muted">{t("hint")}</span>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={t("search")}
        placeholder={t("placeholder")}
        className={inputCls}
      />
      {picked && (
        <span className="text-xs text-ok" role="status">
          {t("picked", { number: picked })}
        </span>
      )}
      {q.trim().length >= 2 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={t("results")}>
          {searched && found.length === 0 && <li className="text-muted">{t("none")}</li>}
          {found.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-mono font-semibold">{o.number}</span> · {o.customerName ?? "—"} ·{" "}
                <span className="font-mono">{o.countryCode ?? "—"}</span> ·{" "}
                <span className="text-muted">{tStatus(o.status)}</span>
              </span>
              <button
                type="button"
                className={ghostButtonCls}
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const d = await orderDraftForManualAction(o.id);
                    if ("error" in d) return setError(t("failed"));
                    // Still at a warehouse: a manual parcel would send it twice — only on a person's word.
                    if (
                      d.liveShipment &&
                      !window.confirm(
                        t("live", {
                          warehouse: d.liveShipment.warehouse ?? "—",
                          ref: d.liveShipment.externalId ?? "—",
                          status: d.liveShipment.status,
                        }),
                      )
                    )
                      return;
                    onPick(d);
                    setQ("");
                    setFound([]);
                    setSearched(false);
                  })
                }
              >
                {t("use")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <span className="text-block" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
