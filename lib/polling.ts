import { getJob, type JobStatus } from "./descript-client.js";
import { logger } from "./logger.js";

interface PollOptions {
  maxAttempts?: number;
  intervalMs?: number;
}

export async function pollJobUntilComplete(
  token: string,
  jobId: string,
  options?: PollOptions,
  requestId?: string
): Promise<JobStatus | null> {
  const maxAttempts = options?.maxAttempts ?? 20;
  const intervalMs = options?.intervalMs ?? 10_000;

  for (let i = 0; i < maxAttempts; i++) {
    const job = await getJob(token, jobId, requestId);
    logger.debug(
      "poll_job_status",
      { job_id: jobId, job_state: job.job_state, attempt: i + 1, max_attempts: maxAttempts },
      requestId
    );
    if (job.job_state === "stopped" || job.job_state === "failed") {
      return job;
    }
    if (i < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return null;
}
