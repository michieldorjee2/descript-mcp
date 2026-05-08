import { logger } from "./logger.js";

const BASE_URL = "https://descriptapi.com/v1";

export class DescriptApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Descript API error ${status}: ${body}`);
    this.name = "DescriptApiError";
  }
}

interface ImportProjectMediaBody {
  project_name: string;
  project_id?: string;
  team_access?: string;
  add_media: Record<string, { url: string }>;
  add_compositions?: Array<{
    name: string;
    clips: Array<{ media: string }>;
  }>;
  callback_url?: string;
}

interface AgentJobBody {
  project_id?: string;
  project_name?: string;
  composition_id?: string;
  model?: string;
  prompt: string;
  team_access?: string;
  callback_url?: string;
}

interface ListJobsParams {
  project_id?: string;
  type?: string;
  cursor?: string;
  limit?: number;
  created_after?: string;
  created_before?: string;
}

interface EditInDescriptBody {
  partner_drive_id: string;
  project_schema: {
    schema_version: string;
    source_id?: string;
    files: Array<{ uri: string; start_offset_seconds?: number }>;
  };
}

export interface JobResponse {
  job_id: string;
  drive_id?: string;
  project_id?: string;
  project_url?: string;
}

export interface JobStatus {
  job_id: string;
  job_type: string;
  job_state: string;
  created_at: string;
  stopped_at?: string;
  project_id?: string;
  project_url?: string;
  result?: Record<string, unknown>;
}

interface JobListResponse {
  data: JobStatus[];
  pagination: { next_cursor?: string };
}

interface PublishedProject {
  project_id: string;
  publish_type: string;
  privacy: string;
  metadata: {
    title: string;
    duration_seconds: number;
    duration_formatted: string;
    published_at: string;
    published_by: { first_name: string; last_name: string };
  };
  subtitles?: string;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function request<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  requestId?: string
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startMs = Date.now();
    let res: Response;

    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (networkErr) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      if (attempt < MAX_RETRIES) {
        logger.warn(
          "descript_api_network_error",
          { method, path, attempt, delay_ms: delay, error: String(networkErr) },
          requestId
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw networkErr;
    }

    const latencyMs = Date.now() - startMs;
    logger.info(
      "descript_api_call",
      { method, path, status: res.status, latency_ms: latencyMs, attempt },
      requestId
    );

    if (res.status === 204) return undefined as T;

    const data = await res.json();

    if (!res.ok) {
      if (isRetryable(res.status) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        logger.warn(
          "descript_api_retrying",
          { method, path, status: res.status, attempt, delay_ms: delay },
          requestId
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new DescriptApiError(res.status, JSON.stringify(data));
    }

    return data as T;
  }

  // Unreachable, but satisfies TypeScript
  throw new DescriptApiError(0, "Request exhausted retries");
}

export async function importProjectMedia(
  token: string,
  body: ImportProjectMediaBody,
  requestId?: string
): Promise<JobResponse> {
  return request<JobResponse>(token, "POST", "/jobs/import/project_media", body, requestId);
}

export async function createAgentJob(
  token: string,
  body: AgentJobBody,
  requestId?: string
): Promise<JobResponse> {
  return request<JobResponse>(token, "POST", "/jobs/agent", body, requestId);
}

export async function listJobs(
  token: string,
  params: ListJobsParams,
  requestId?: string
): Promise<JobListResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const query = qs.toString();
  return request<JobListResponse>(
    token,
    "GET",
    `/jobs${query ? `?${query}` : ""}`,
    undefined,
    requestId
  );
}

export async function getJob(
  token: string,
  jobId: string,
  requestId?: string
): Promise<JobStatus> {
  return request<JobStatus>(token, "GET", `/jobs/${jobId}`, undefined, requestId);
}

export async function cancelJob(
  token: string,
  jobId: string,
  requestId?: string
): Promise<void> {
  return request<void>(token, "DELETE", `/jobs/${jobId}`, undefined, requestId);
}

export async function checkStatus(
  token: string,
  requestId?: string
): Promise<{ status: string }> {
  return request<{ status: string }>(token, "GET", "/status", undefined, requestId);
}

export async function generateEditInDescriptUrl(
  token: string,
  body: EditInDescriptBody,
  requestId?: string
): Promise<{ url: string }> {
  return request<{ url: string }>(
    token,
    "POST",
    "/edit_in_descript/schema",
    body,
    requestId
  );
}

export async function getPublishedProject(
  token: string,
  slug: string,
  requestId?: string
): Promise<PublishedProject> {
  return request<PublishedProject>(
    token,
    "GET",
    `/published_projects/${encodeURIComponent(slug)}`,
    undefined,
    requestId
  );
}
