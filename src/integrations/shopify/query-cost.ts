/**
 * Conservative upper bound of Shopify's *requested* query cost, for tests: every object costs 1, scalars 0,
 * a connection costs 2 + first × (cost of one node). Fragments are expanded. Over-estimates on purpose (it
 * counts `nodes`/`edges` wrappers as objects), so "estimate < 1000" implies Shopify will accept the query.
 */
export function estimateQueryCost(document: string, variables: Record<string, number> = {}): number {
  const fragments = new Map<string, string>();
  const fragRe = /fragment\s+(\w+)\s+on\s+\w+\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = fragRe.exec(document))) fragments.set(m[1]!, block(document, fragRe.lastIndex - 1));
  const op = /(?:query|mutation)\s*\w*\s*(?:\([^)]*\))?\s*\{/.exec(document);
  if (!op) throw new Error("no operation");
  return selectionCost(block(document, op.index + op[0].length - 1), fragments, variables);
}

/** Text between the brace at `open` and its matching close brace. */
function block(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(open + 1, i);
  }
  throw new Error("unbalanced braces");
}

function selectionCost(sel: string, fragments: Map<string, string>, vars: Record<string, number>): number {
  let cost = 0;
  let i = 0;
  while (i < sel.length) {
    const spread = /^\s*\.\.\.\s*(\w+)/.exec(sel.slice(i));
    if (spread) {
      cost += selectionCost(fragments.get(spread[1]!) ?? "", fragments, vars);
      i += spread[0].length;
      continue;
    }
    const field = /^\s*(\w+)\s*(\([^)]*\))?\s*(\{)?/.exec(sel.slice(i));
    if (!field || !field[0].trim()) {
      i++;
      continue;
    }
    if (!field[3]) {
      i += field[0].length; // scalar
      continue;
    }
    const open = i + field[0].length - 1;
    const inner = block(sel, open);
    const first = /\bfirst\s*:\s*(\$?\w+)/.exec(field[2] ?? "")?.[1];
    const n =
      first === undefined ? undefined : first.startsWith("$") ? (vars[first.slice(1)] ?? 250) : Number(first);
    const child = selectionCost(inner, fragments, vars);
    cost += n === undefined ? 1 + child : 2 + n * (1 + child);
    i = open + inner.length + 2;
  }
  return cost;
}
