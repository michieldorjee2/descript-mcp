import { getJob, type JobStatus } from "./descript-client.js";

interface PollOptions {
  maxAttempts?: number;
  intervalMs?: number;
}

/**
 * Poll a Descript job until it reaches a terminal state ("stopped")
 * or the max attempts are exhausted.
 *
 * Returns the job status if complete, or null if still running after max attempts.
 */
export async function pollJobUntilComplete(
  token: string,
  jobId: string,
  options?: PollOptions
): Promise<JobStatus | null> {
  const maxAttempts = options?.maxAttempts ?? 5;
  const intervalMs = options?.intervalMs ?? 3000;

  for (let i = 0; i < maxAttempts; i++) {
    const job = await getJob(token, jobId);
    if (job.job_state === "stopped" || job.job_state === "failed") {
      return job;
    }
    if (i < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return null;
}
