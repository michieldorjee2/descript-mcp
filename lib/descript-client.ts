const BASE_URL = "https://api.descriptapi.com/v1";

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

async function request<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return undefined as T;

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Descript API error ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data as T;
}

export async function importProjectMedia(
  token: string,
  body: ImportProjectMediaBody
): Promise<JobResponse> {
  return request<JobResponse>(token, "POST", "/jobs/import/project_media", body);
}

export async function createAgentJob(
  token: string,
  body: AgentJobBody
): Promise<JobResponse> {
  return request<JobResponse>(token, "POST", "/jobs/agent", body);
}

export async function listJobs(
  token: string,
  params: ListJobsParams
): Promise<JobListResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const query = qs.toString();
  return request<JobListResponse>(
    token,
    "GET",
    `/jobs${query ? `?${query}` : ""}`
  );
}

export async function getJob(
  token: string,
  jobId: string
): Promise<JobStatus> {
  return request<JobStatus>(token, "GET", `/jobs/${jobId}`);
}

export async function cancelJob(
  token: string,
  jobId: string
): Promise<void> {
  return request<void>(token, "DELETE", `/jobs/${jobId}`);
}

export async function checkStatus(
  token: string
): Promise<{ status: string }> {
  return request<{ status: string }>(token, "GET", "/status");
}

export async function generateEditInDescriptUrl(
  token: string,
  body: EditInDescriptBody
): Promise<{ url: string }> {
  return request<{ url: string }>(
    token,
    "POST",
    "/edit_in_descript/schema",
    body
  );
}

export async function getPublishedProject(
  token: string,
  slug: string
): Promise<PublishedProject> {
  return request<PublishedProject>(
    token,
    "GET",
    `/published_projects/${encodeURIComponent(slug)}`
  );
}
