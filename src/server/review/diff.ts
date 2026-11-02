import { z } from "zod";

/**
 * The shipping address an operator may correct on the order detail (P4-04) and the field-level diff of those
 * corrections (P4-05: the future AI training data — e.g. phone "0888…" → "+359888…"). Pure.
 *
 * Field names follow the validator findings (src/server/checks): `shippingAddress.<key>` and `phone`, so a
 * finding's `field` / `suggestedFix.field` points straight at an editor input.
 */

export const ADDRESS_KEYS = [
  "name",
  "company",
  "address1",
  "address2",
  "city",
  "zip",
  "province",
  "countryCode",
] as const;
export type AddressKey = (typeof ADDRESS_KEYS)[number];

/** Every field of the editor, as finding paths. */
export const EDITABLE_FIELDS = [
  ...ADDRESS_KEYS.map((k) => `shippingAddress.${k}` as const),
  "phone",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
export const isEditableField = (f: string | null | undefined): f is EditableField =>
  !!f && (EDITABLE_FIELDS as readonly string[]).includes(f);

const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.replace(/\s+/g, " ").trim() || null)
    .nullable()
    .optional();

/** What the editor sends (every key optional: a suggested fix sends one field). */
export const AddressEdit = z
  .object({
    name: text(120),
    company: text(120),
    address1: text(200),
    address2: text(200),
    city: text(100),
    zip: text(20),
    province: text(100),
    countryCode: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase() || null)
      .pipe(
        z
          .string()
          .regex(/^[A-Z]{2}$/)
          .nullable(),
      )
      .nullable()
      .optional(),
    phone: text(40),
  })
  .strict();
export type AddressEdit = z.output<typeof AddressEdit>;

/** The values the editor shows (current = corrected address, phone as the senders read it). */
export interface EditorValues {
  name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  zip: string | null;
  province: string | null;
  countryCode: string | null;
  phone: string | null;
}

type Addr = Record<string, unknown> | null | undefined;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

export function editorValues(address: Addr, orderPhone: string | null): EditorValues {
  const a = address ?? {};
  return {
    name: str(a.name),
    company: str(a.company),
    address1: str(a.address1),
    address2: str(a.address2),
    city: str(a.city),
    zip: str(a.zip),
    province: str(a.province),
    countryCode: str(a.countryCode)?.toUpperCase() ?? null,
    // The senders and the validators read Order.phone first, then the address phone.
    phone: orderPhone ?? str(a.phone),
  };
}

export interface FieldChange {
  field: EditableField;
  from: string | null;
  to: string | null;
  /** "manual" (typed) or "suggested_fix:<finding code>" (one click on a validator suggestion). */
  via?: string;
}

/** Field-level changes from `before` to `after` (only the keys present in `edit`). */
export function diffValues(before: EditorValues, edit: AddressEdit, via = "manual"): FieldChange[] {
  const out: FieldChange[] = [];
  for (const key of [...ADDRESS_KEYS, "phone"] as const) {
    if (!(key in edit) || edit[key] === undefined) continue;
    const to = edit[key] ?? null;
    const from = before[key] ?? null;
    if (from === to) continue;
    out.push({ field: key === "phone" ? "phone" : `shippingAddress.${key}`, from, to, via });
  }
  return out;
}

/**
 * Merges new changes into the diff of the same review session: a field keeps its first `from` and takes the
 * latest `to`; a field edited back to where it started drops out.
 */
export function mergeDiff(existing: readonly FieldChange[], next: readonly FieldChange[]): FieldChange[] {
  const byField = new Map(existing.map((c) => [c.field, { ...c }]));
  for (const c of next) {
    const prev = byField.get(c.field);
    if (prev) byField.set(c.field, { ...prev, to: c.to, via: c.via ?? prev.via });
    else byField.set(c.field, { ...c });
  }
  const order = new Map(EDITABLE_FIELDS.map((f, i) => [f, i]));
  return [...byField.values()]
    .filter((c) => c.from !== c.to)
    .sort((a, b) => order.get(a.field)! - order.get(b.field)!);
}

/** Reads a stored Review.diff defensively (older rows, or hand-made ones). */
export function parseDiff(v: unknown): FieldChange[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is FieldChange => !!c && typeof c === "object" && isEditableField((c as { field?: string }).field),
  );
}

/**
 * The corrected address after an edit: the stored keys stay (e.g. provinceCode, country name) unless the edit
 * makes them wrong — a new country code drops the country name, a new province drops its code.
 */
export function applyEdit(address: Addr, edit: AddressEdit): Record<string, string | null> {
  const a: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(address ?? {})) a[k] = typeof v === "string" ? v : null;
  for (const key of ADDRESS_KEYS) {
    const v = edit[key];
    if (v === undefined) continue;
    if (key === "countryCode" && (a.countryCode ?? null) !== v) a.country = null;
    if (key === "province" && (a.province ?? null) !== v) a.provinceCode = null;
    a[key] = v;
  }
  if (edit.phone !== undefined) a.phone = edit.phone;
  return a;
}
