"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { isScope, SCOPE_COOKIE, SCOPE_TYPES } from "@/components/shell/scope";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { DIRECTORY_TABS, refreshDirectory } from "@/server/directory/directory";
import { webBoss } from "@/server/jobs/boss";

/**
 * Офиси, PUDO, потребители → "Обнови": queues the existing read-only sync jobs of the connections in scope.
 * Nothing here calls a vendor; the worker does the GET/list calls.
 */
type Result = { ok?: boolean; queued?: number; already?: boolean; error?: string } | undefined;

export async function refreshDirectoryAction(tab: string, _prev: Result): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    const t = z.enum(DIRECTORY_TABS).parse(tab);
    const raw = (await cookies()).get(SCOPE_COOKIE)?.value;
    const scope = isScope(raw) ? raw : "all";
    const r = await refreshDirectory(
      { ...actorFrom(ctx), activeCompanyId: ctx.activeCompanyId, lineCompanyIds: ctx.lineCompanyIds },
      t,
      await webBoss(),
      scope === "all" ? undefined : SCOPE_TYPES[scope],
    );
    if (r.queued === 0 && r.already === 0) return { error: "nothing" };
    return { ok: true, queued: r.queued, already: r.queued === 0 };
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: "forbidden" };
    if (err instanceof DomainError || err instanceof z.ZodError) return { error: "invalid" };
    throw err;
  }
}
