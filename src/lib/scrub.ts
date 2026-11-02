/**
 * Text that may carry customer data (vendor error messages, exception text) before it goes to logs or the
 * database: emails and long digit runs (phones, card-like numbers) are masked, and length is capped.
 */
export function scrubText(text: string, max = 500): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s-]{6,}\d/g, "[number]")
    .slice(0, max);
}
