"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import {
  createManualAction,
  officesAction,
  previewManualAction,
  quoteAction,
  quoteStatusAction,
} from "@/app/actions/labels";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";
import type { Finding } from "@/server/checks/findings";
import type { ManualPreview, ManualShipmentInput } from "@/server/labels";

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
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : undefined);

export function ManualForm(props: {
  companies: { id: string; name: string }[];
  defaultCompanyId: string;
  connections: Conn[];
  couriers: Record<string, Courier[]>;
  products: { id: string; sku: string; name: string }[];
}) {
  const t = useTranslations("manual");
  const tm = useTranslations("mode");
  const locale = useLocale();
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("JOY_LABEL");
  const [companyId, setCompanyId] = useState(props.defaultCompanyId);
  const options = props.connections.filter((c) => TYPES[kind].includes(c.type));
  const [connectionId, setConnectionId] = useState(options[0]?.id ?? "");
  const conn = options.find((c) => c.id === connectionId) ?? options[0] ?? null;
  const [r, setR] = useState({
    name: "",
    email: "",
    phone: "",
    address1: "",
    buildingNumber: "",
    address2: "",
    city: "",
    zip: "",
    region: "",
    countryCode: "BG",
  });
  const [cod, setCod] = useState("");
  const [currency, setCurrency] = useState("EUR");
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
  const [lines, setLines] = useState<{ productId: string; quantity: string; unitPrice: string }[]>([
    { productId: "", quantity: "1", unitPrice: "" },
  ]);
  const [preview, setPreview] = useState<ManualPreview | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(() => uuid());
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
        zip: r.zip || null,
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
      clientRequestId: requestId,
    };
  })();

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
        onSubmit={(e) => {
          e.preventDefault();
          check();
        }}
      >
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
              onChange={(e) => (setCompanyId(e.target.value), invalidate())}
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
            {t("form.name")}
            <input value={r.name} onChange={set("name")} required maxLength={100} className={inputCls} />
          </label>
          <label className={labelCls}>
            {t("form.phone")}
            <input
              value={r.phone}
              onChange={set("phone")}
              required
              maxLength={40}
              className={`${inputCls} font-mono`}
            />
          </label>
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
            {t("form.country")}
            <input
              value={r.countryCode}
              onChange={set("countryCode")}
              required
              maxLength={2}
              className={`${inputCls} w-24 font-mono uppercase`}
            />
          </label>
          <label className={labelCls}>
            {t("form.street")}
            <input
              value={r.address1}
              onChange={set("address1")}
              required
              maxLength={200}
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
          <label className={labelCls}>
            {t("form.city")}
            <input value={r.city} onChange={set("city")} required maxLength={100} className={inputCls} />
          </label>
          <label className={labelCls}>
            {t("form.zip")}
            <input value={r.zip} onChange={set("zip")} maxLength={15} className={`${inputCls} font-mono`} />
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
          <label className={labelCls}>
            {t("form.cod")}
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
            <span className="text-xs font-normal text-muted">{t("form.codHint")}</span>
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
            {lines.map((l, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <label className={`${labelCls} min-w-64 flex-1`}>
                  {t("form.product")}
                  <select
                    value={l.productId}
                    onChange={(e) => (
                      setLines((ls) => ls.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x))),
                      invalidate()
                    )}
                    className={inputCls}
                  >
                    <option value="">—</option>
                    {props.products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sku} · {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelCls}>
                  {t("form.qty")}
                  <input
                    value={l.quantity}
                    inputMode="numeric"
                    onChange={(e) => (
                      setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x))),
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
                      setLines((ls) => ls.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x))),
                      invalidate()
                    )}
                    className={`${inputCls} w-28 font-mono`}
                  />
                </label>
                {lines.length > 1 && (
                  <button
                    type="button"
                    className={ghostButtonCls}
                    onClick={() => (setLines((ls) => ls.filter((_, j) => j !== i)), invalidate())}
                  >
                    {t("form.removeLine")}
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className={`${ghostButtonCls} self-start`}
              onClick={() => setLines((ls) => [...ls, { productId: "", quantity: "1", unitPrice: "" }])}
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
