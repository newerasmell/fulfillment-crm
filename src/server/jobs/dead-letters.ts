import type { PgBoss } from "pg-boss";
import { DEAD_LETTER_QUEUE } from "./queues";

export interface DeadLetterView {
  id: string;
  sourceQueue: string | null;
  createdOn: Date;
  retryCount: number;
  error: string;
}

const accountOf = (data: unknown) =>
  data && typeof data === "object" && "accountId" in data
    ? String((data as { accountId: unknown }).accountId)
    : null;

function errorText(output: unknown) {
  if (output && typeof output === "object" && "message" in output)
    return String((output as { message: unknown }).message);
  return output ? JSON.stringify(output).slice(0, 500) : "";
}

/**
 * Dead letters visible to one account: its own jobs plus system jobs that carry no account at all.
 * Job payloads are not shown (they may hold ids of other accounts' records).
 */
export async function listDeadLetters(
  boss: PgBoss,
  accountId: string,
  limit = 200,
): Promise<DeadLetterView[]> {
  const jobs = await boss.findJobs(DEAD_LETTER_QUEUE, { limit });
  return jobs
    .filter((j) => {
      const owner = accountOf(j.data);
      return owner === null || owner === accountId;
    })
    .map((j) => ({
      id: j.id,
      sourceQueue: j.sourceName,
      createdOn: j.createdOn,
      retryCount: j.retryCount,
      error: errorText(j.output),
    }))
    .reverse();
}

/** Sends a dead letter back to the queue it failed on (only if it belongs to the account or to nobody). */
export async function redriveDeadLetter(boss: PgBoss, accountId: string, jobId: string) {
  const [job] = await boss.findJobs(DEAD_LETTER_QUEUE, { id: jobId });
  if (!job) return false;
  const owner = accountOf(job.data);
  if (owner !== null && owner !== accountId) return false;
  return (await boss.redrive(DEAD_LETTER_QUEUE, { ids: [jobId] })) > 0;
}
