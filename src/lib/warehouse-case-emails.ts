/**
 * The emails of „Блокирани в склад“ (owner request 2026-11-18), assembled as plain English text for a person to
 * copy into the company's Gmail. Pure: no database, no clock (the caller passes `now`).
 *  - warehouse 1: the orders have not left the warehouse for a day → ship or say it is out of stock, today;
 *  - warehouse 2: no reply / still not shipped → second notice;
 *  - warehouse 3: the decision point (owner: shipped or cancelled within 2–3 days) → final notice with a
 *    deadline, the escalation addresses added;
 *  - customer: the order is delayed → a replacement or a refund, optionally a discount code.
 * Order numbers and products only, never the customer's personal data, in a warehouse email.
 */

export const WAREHOUSE_LEVELS = [1, 2, 3] as const;
export type WarehouseLevel = (typeof WAREHOUSE_LEVELS)[number];

export interface CaseLine {
  /** The reference the warehouse knows the order by (what the CRM sent). */
  ref: string;
  orderNumber: string;
  awb: string | null;
  status: string | null;
  since: Date;
  hours: number;
  items: { sku: string | null; title: string; quantity: number }[];
  /** SKUs the warehouse's own stock report shows 0 for. */
  zeroStock: string[];
}

const TZ = "Europe/Bratislava";
export function formatWhen(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("day")}.${p("month")}.${p("year")} ${p("hour")}:${p("minute")}`;
}
const formatDay = (d: Date) => formatWhen(d).slice(0, 10);

function lineText(l: CaseLine) {
  const items = l.items.map((i) => `${i.quantity} x ${i.sku ?? i.title}`).join(", ");
  const head = [
    l.ref,
    l.awb ? `AWB ${l.awb}` : null,
    l.status ? `status "${l.status}"` : null,
    `sent ${formatWhen(l.since)}`,
    `${l.hours} h`,
  ]
    .filter(Boolean)
    .join(" | ");
  const note = l.zeroStock.length ? `\n    Your stock report shows 0 for ${l.zeroStock.join(", ")}.` : "";
  return `- ${head}\n    ${items}${note}`;
}

export interface WarehouseEmailInput {
  level: WarehouseLevel;
  company: string;
  warehouse: string;
  lines: CaseLine[];
  to: string[];
  cc: string[];
  escalationTo: string[];
  /** The last email of this case we sent, and whether the warehouse replied after it. */
  lastSentAt: Date | null;
  repliedSinceLast: boolean;
  now: Date;
  /** Hours until the orders are cancelled (the final notice). */
  deadlineHours?: number;
}

export interface Email {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

export function warehouseEmail(input: WarehouseEmailInput): Email {
  const lines = [...input.lines].sort((a, b) => b.hours - a.hours);
  const oldest = lines[0]?.hours ?? 0;
  const list = lines.map(lineText).join("\n");
  const ask =
    "Please reply today for each order:\n" +
    "- it ships today or tomorrow, or\n" +
    "- the item is not in stock: then please do not ship it, tell us and we will cancel the order.";
  const sign = `Thank you,\n${input.company}`;
  const n = lines.length;
  const orders = n === 1 ? "order" : "orders";
  if (input.level === 1) {
    return {
      to: input.to,
      cc: input.cc,
      subject: `${n} ${orders} not processed for over ${oldest} h – ${input.company}`,
      body:
        `Hello,\n\nthe ${orders} below ${n === 1 ? "was" : "were"} sent to you and ${n === 1 ? "has" : "have"} not ` +
        `left the warehouse yet. The oldest has been waiting ${oldest} hours.\n\n${list}\n\n${ask}\n\n${sign}`,
    };
  }
  const last = input.lastSentAt ? formatDay(input.lastSentAt) : null;
  if (input.level === 2) {
    const opening = input.repliedSinceLast
      ? `thank you for your reply. The ${orders} below ${n === 1 ? "has" : "have"} still not left the warehouse.`
      : last
        ? `we wrote to you on ${last} about the ${orders} below and have had no reply. They have still not left ` +
          `the warehouse.`
        : `the ${orders} below ${n === 1 ? "has" : "have"} still not left the warehouse.`;
    return {
      to: input.to,
      cc: input.cc,
      subject:
        `SECOND NOTICE: ${n} ${orders} stuck for over ${oldest} h` +
        (last && !input.repliedSinceLast ? `, no reply since ${last}` : "") +
        ` – ${input.company}`,
      body: `Hello,\n\n${opening}\n\n${list}\n\n${ask}\n\n${sign}`,
    };
  }
  const deadline = formatWhen(new Date(input.now.getTime() + (input.deadlineHours ?? 24) * 3_600_000));
  return {
    to: input.to,
    cc: [...new Set([...input.cc, ...input.escalationTo])].filter((e) => !input.to.includes(e)),
    subject: `FINAL NOTICE: ${n} ${orders} stuck for over ${oldest} h – ${input.company}`,
    body:
      `Hello,\n\nthe ${orders} below ${n === 1 ? "has" : "have"} not left the warehouse for over ${oldest} hours` +
      (last ? ` and we have written about ${n === 1 ? "it" : "them"} since ${last}` : "") +
      `. We are escalating this.\n\n${list}\n\n` +
      `Orders that are not handed to the courier by ${deadline} (${TZ} time) will be cancelled by us and their ` +
      `items treated as out of stock. If an item is not there, please tell us now.\n\n${sign}`,
  };
}

export const DEFAULT_CUSTOMER_SUBJECT = "Your order {order_number}: a delay";
export const DEFAULT_CUSTOMER_BODY = [
  "Hello {customer_name},",
  "",
  "we are sorry: your order {order_number} ({items}) is delayed at our warehouse and has not shipped yet.",
  "",
  "What would you prefer?",
  "1. We replace it with another product of the same value and send it right away.",
  "2. We cancel the order and refund you in full.",
  "",
  "As an apology, here is a {discount_percent}% discount code for your next order: {discount_code}",
  "",
  "Please reply to this email with your choice.",
  "",
  "Kind regards,",
  "{store}",
].join("\n");

export const CUSTOMER_PLACEHOLDERS = [
  "customer_name",
  "order_number",
  "items",
  "discount_percent",
  "discount_code",
  "store",
] as const;

export interface CustomerEmailInput {
  subject: string | null;
  body: string | null;
  to: string | null;
  customerName: string | null;
  orderNumber: string;
  items: { title: string; quantity: number }[];
  store: string;
  discountPercent: number | null;
  discountCode: string | null;
}

/** Fills the company's customer template. A line about the discount is left out when there is no code. */
export function customerEmail(input: CustomerEmailInput): Email {
  const code = input.discountCode?.trim() || null;
  const values: Record<string, string> = {
    customer_name: input.customerName?.trim() || "customer",
    order_number: input.orderNumber,
    items: input.items.map((i) => (i.quantity > 1 ? `${i.quantity} x ${i.title}` : i.title)).join(", "),
    discount_percent: input.discountPercent ? String(input.discountPercent) : "",
    discount_code: code ?? "",
    store: input.store,
  };
  const fill = (t: string) =>
    t.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? values[k]! : m));
  const body = (input.body || DEFAULT_CUSTOMER_BODY)
    .split("\n")
    .filter((l) => code || !/\{discount_(code|percent)\}/.test(l))
    .map(fill)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return {
    to: input.to ? [input.to] : [],
    cc: [],
    subject: fill(input.subject || DEFAULT_CUSTOMER_SUBJECT),
    body,
  };
}
