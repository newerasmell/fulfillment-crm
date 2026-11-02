import type { PgBoss } from "pg-boss";
import { DEAD_LETTER_QUEUE } from "./queues";

export interface DeadLetterView {
  id: string;
  sourceQueue: string | null;
  createdOn: Date;
  retryCount: number;
  error: string;
}

function errorText(output: unknown) {
  if (output && typeof output === "object" && "message" in output)
    return String((output as { message: unknown }).message);
  return output ? JSON.stringify(output).slice(0, 500) : "";
}

/**
 * Dead letters of ONE account: only jobs whose payload names it (matched in the query, so other accounts'
 * jobs cannot crowd them out). System jobs without an account are not shown to tenants at all — they can
 * carry errors from cross-account work; operators read them in the worker logs.
 */
export async function listDeadLetters(
  boss: PgBoss,
  accountId: string,
  limit = 200,
): Promise<DeadLetterView[]> {
  const jobs = await boss.findJobs(DEAD_LETTER_QUEUE, { data: { accountId }, limit });
  return jobs
    .map((j) => ({
      id: j.id,
      sourceQueue: j.sourceName,
      createdOn: j.createdOn,
      retryCount: j.retryCount,
      error: errorText(j.output),
    }))
    .reverse();
}

/** Sends one of the account's dead letters back to the queue it failed on. */
export async function redriveDeadLetter(boss: PgBoss, accountId: string, jobId: string) {
  const [job] = await boss.findJobs(DEAD_LETTER_QUEUE, { id: jobId, data: { accountId } });
  if (!job) return false;
  return (await boss.redrive(DEAD_LETTER_QUEUE, { ids: [jobId] })) > 0;
}
