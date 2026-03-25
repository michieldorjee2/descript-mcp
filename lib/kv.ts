import { kv } from "@vercel/kv";

const TTL_SECONDS = 24 * 60 * 60; // 24 hours

// --- Job result caching ---

export interface CachedJobResult {
  job_id: string;
  job_type: string;
  job_state: string;
  created_at: string;
  stopped_at?: string;
  cached_at: string;
  project_id?: string;
  project_url?: string;
  result?: Record<string, unknown>;
}

function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

export async function cacheJobResult(data: CachedJobResult): Promise<void> {
  await kv.set(jobKey(data.job_id), data, { ex: TTL_SECONDS });
}

export async function getCachedJobResult(
  jobId: string
): Promise<CachedJobResult | null> {
  return kv.get<CachedJobResult>(jobKey(jobId));
}

// --- Caption job tracking ---

export interface CaptionJob {
  id: string; // a generated ID for this caption request
  media_url: string;
  project_name: string;
  import_job_id: string;
  agent_job_id?: string;
  project_id?: string;
  project_url?: string;
  status: "import_in_progress" | "import_failed" | "caption_export_started" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  captions?: string;
}

function captionJobKey(id: string): string {
  return `caption:${id}`;
}

const CAPTION_INDEX_KEY = "caption_jobs_index";

export async function saveCaptionJob(job: CaptionJob): Promise<void> {
  await kv.set(captionJobKey(job.id), job, { ex: TTL_SECONDS });
  // Also add to the index (a sorted set scored by timestamp)
  await kv.zadd(CAPTION_INDEX_KEY, {
    score: new Date(job.created_at).getTime(),
    member: job.id,
  });
  // Trim entries older than 24h from the index
  const cutoff = Date.now() - TTL_SECONDS * 1000;
  await kv.zremrangebyscore(CAPTION_INDEX_KEY, 0, cutoff);
}

export async function getCaptionJob(
  id: string
): Promise<CaptionJob | null> {
  return kv.get<CaptionJob>(captionJobKey(id));
}

export async function getCaptionJobByJobId(
  jobId: string
): Promise<CaptionJob | null> {
  // Look up caption job by import_job_id or agent_job_id
  // We store a reverse mapping for this
  const captionId = await kv.get<string>(`jobmap:${jobId}`);
  if (!captionId) return null;
  return getCaptionJob(captionId);
}

export async function mapJobIdToCaptionId(
  jobId: string,
  captionId: string
): Promise<void> {
  await kv.set(`jobmap:${jobId}`, captionId, { ex: TTL_SECONDS });
}

export async function listCaptionJobs(
  limit = 20
): Promise<CaptionJob[]> {
  // Get the most recent caption job IDs from the sorted set
  const ids = await kv.zrange(CAPTION_INDEX_KEY, 0, limit - 1, {
    rev: true,
  }) as string[];
  if (!ids || ids.length === 0) return [];

  const jobs: CaptionJob[] = [];
  for (const id of ids) {
    const job = await kv.get<CaptionJob>(captionJobKey(id));
    if (job) jobs.push(job);
  }
  return jobs;
}
