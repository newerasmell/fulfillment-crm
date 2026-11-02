import { normalisePhoneE164 } from "@/integrations/fhb-v3/phone";
import { JoyShipmentCreate } from "./schemas";
import type { JoyShipmentDraft } from "./validators";

/**
 * CRM draft → POST /shipments body. Only call on a draft whose pre-flight has no hard finding; the strict
 * schema parse is the last guard (it throws instead of sending something Joy would refuse).
 */
export function buildJoyShipment(
  d: JoyShipmentDraft & {
    sender?: string | null;
    senderName?: string | null;
    labelOrientation?: "L" | "P" | null;
  },
): JoyShipmentCreate {
  const country = d.country!.trim().toLowerCase();
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return JoyShipmentCreate.parse({
    id: d.id,
    parcelService: d.parcelService!.trim(),
    name: d.name!.trim(),
    street: d.street!.trim(),
    city: d.city!.trim(),
    ...(d.province?.trim() ? { province: d.province.trim() } : {}),
    zip: d.zip!.trim(),
    country,
    email: d.email!.trim(),
    phone: normalisePhoneE164(d.phone, country),
    variableSymbol: d.variableSymbol,
    ...(d.cod && d.cod > 0 ? { cod: round2(d.cod) } : {}),
    ...(d.sender?.trim() ? { sender: d.sender.trim() } : {}),
    ...(d.senderName?.trim() ? { senderName: d.senderName.trim() } : {}),
    ...(d.note?.trim() ? { note: d.note.trim() } : {}),
    numberOfPackages: d.numberOfPackages,
    ...(d.weights && d.weights.length ? { weight: d.weights.map((w) => Math.round(w * 1000) / 1000) } : {}),
    ...(d.deliveryPoint?.trim() ? { deliveryPoint: d.deliveryPoint.trim() } : {}),
    ...(d.labelOrientation ? { labelOrientation: d.labelOrientation } : {}),
  });
}

/** Tracking numbers from a create/reprint answer (packages[].tracking, nulls dropped, deduplicated). */
export function trackingFromLabel(r: { packages?: { tracking?: string | null }[] | null }): string[] {
  return [...new Set((r.packages ?? []).map((p) => p.tracking?.trim()).filter((t): t is string => !!t))];
}
