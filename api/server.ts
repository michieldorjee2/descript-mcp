import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import * as client from "../lib/descript-client.js";
import { pollJobUntilComplete } from "../lib/polling.js";
import {
  cacheJobResult,
  getCachedJobResult,
  saveCaptionJob,
  getCaptionJob,
  getCaptionJobByJobId,
  mapJobIdToCaptionId,
  listCaptionJobs as kvListCaptionJobs,
  type CaptionJob,
} from "../lib/kv.js";
import {
  importProjectMediaSchema,
  agentJobSchema,
  listJobsSchema,
  getJobSchema,
  cancelJobSchema,
  editInDescriptSchema,
  getPublishedProjectSchema,
  generateCaptionsSchema,
  getCachedResultSchema,
  listCaptionJobsSchema,
} from "../lib/schemas.js";
import {
  handleProtectedResourceMetadata,
  handleAuthServerMetadata,
  handleRegister,
  handleAuthorize,
  handleToken,
} from "../lib/oauth.js";

// --- Token extraction ---
function getToken(extra: any): string {
  const authToken = extra?.authInfo?.token;
  if (authToken) return authToken;

  const headers = extra?.requestInfo?.headers;
  const raw =
    headers?.["x-descript-api-token"] ||
    headers?.["authorization"];
  const token =
    typeof raw === "string"
      ? raw.replace(/^Bearer\s+/i, "")
      : Array.isArray(raw)
        ? raw[0]?.replace(/^Bearer\s+/i, "")
        : undefined;
  if (!token) {
    throw new Error(
      "Missing Descript API token. Either use OAuth or set the x-descript-api-token header."
    );
  }
  return token;
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

// --- MCP Handler ---
const mcpHandler = createMcpHandler(
  (server) => {
    // 1. Check API Status
    server.tool(
      "check_api_status",
      "Check Descript API connectivity and token validity",
      {},
      async (_params, extra) => {
        const token = getToken(extra as any);
        const result = await client.checkStatus(token);
        return text(JSON.stringify(result, null, 2));
      }
    );

    // 2. Import Project Media
    server.tool(
      "import_project_media",
      "Import media files into Descript, create projects, and establish compositions. Returns a job_id to track progress with get_job_status.",
      importProjectMediaSchema,
      async (params, extra) => {
        const token = getToken(extra as any);
        const result = await client.importProjectMedia(token, params);
        return text(JSON.stringify(result, null, 2));
      }
    );

    // 3. Run Agent
    server.tool(
      "run_agent",
      "Use the Descript AI agent to create or edit projects via natural language prompts. Returns a job_id to track progress.",
      agentJobSchema,
      async (params, extra) => {
        const token = getToken(extra as any);
        const result = await client.createAgentJob(token, params);
        return text(JSON.stringify(result, null, 2));
      }
    );

    // 4. List Jobs
    server.tool(
      "list_jobs",
      "List recent Descript jobs with optional filtering by project, type, and date range.",
      listJobsSchema,
      async (params, extra) => {
        const token = getToken(extra as any);
        const result = await client.listJobs(token, params);
        return text(JSON.stringify(result, null, 2));
      }
    );

    // 5. Get Job Status (with auto-caching)
    server.tool(
      "get_job_status",
      "Get the current status and results of a Descript job. Completed results are automatically cached for 24 hours. If the Descript API no longer has the job, the cached result is returned instead.",
      getJobSchema,
      async (params, extra) => {
        const token = getToken(extra as any);

        try {
          const result = await client.getJob(token, params.job_id);

          // Auto-cache if the job reached a terminal state
          if (
            result.job_state === "stopped" ||
            result.job_state === "failed"
          ) {
            await cacheJobResult({
              ...result,
              cached_at: new Date().toISOString(),
            });

            // Also update any linked caption job
            const captionJob = await getCaptionJobByJobId(params.job_id);
            if (captionJob) {
              const updated: CaptionJob = {
                ...captionJob,
                updated_at: new Date().toISOString(),
              };
              if (result.job_state === "failed") {
                updated.status = "failed";
              } else if (captionJob.agent_job_id === params.job_id) {
                updated.status = "completed";
                // Try to extract captions from the agent result
                const agentResult = result.result as any;
                if (agentResult?.output) {
                  updated.captions = agentResult.output;
                } else if (agentResult?.text) {
                  updated.captions = agentResult.text;
                } else {
                  updated.captions = JSON.stringify(agentResult);
                }
              }
              await saveCaptionJob(updated);
            }
          }

          return text(JSON.stringify(result, null, 2));
        } catch (err: any) {
          // If the Descript API no longer has this job, check cache
          const cached = await getCachedJobResult(params.job_id);
          if (cached) {
            return text(
              JSON.stringify(
                {
                  ...cached,
                  _source: "cache",
                  _note:
                    "This result was retrieved from the 24-hour cache because the Descript API no longer has this job.",
                },
                null,
                2
              )
            );
          }
          // Also check if this is a caption job ID
          const captionJob = await getCaptionJob(params.job_id);
          if (captionJob) {
            return text(
              JSON.stringify(
                {
                  ...captionJob,
                  _source: "caption_job_cache",
                  _note:
                    "This is a caption job record from the 24-hour cache.",
                },
                null,
                2
              )
            );
          }
          throw err;
        }
      }
    );

    // 6. Cancel Job
    server.tool(
      "cancel_job",
      "Cancel a running Descript job.",
      cancelJobSchema,
      async (params, extra) => {
        const token = getToken(extra as any);
        await client.cancelJob(token, params.job_id);
        return text(`Job ${params.job_id} cancelled.`);
      }
    );

    // 7. Generate Edit in Descript URL
    server.tool(
      "generate_edit_in_descript_url",
      "Generate a one-time-use URL to import content into the Descript editor (Edit in Descript integration).",
      editInDescriptSchema,
      async (params, extra) => {
        const token = getToken(extra as any);
        const result = await client.generateEditInDescriptUrl(token, params);
        return text(JSON.stringify(result, null, 2));
      }
    );

    // 8. Get Published Project
    server.tool(
      "get_published_project",
      "Get metadata and subtitles (WEBVTT format) for a published Descript project.",
      getPublishedProjectSchema,
      async (params, extra) => {
        const token = getToken(extra as any);
        const result = await client.getPublishedProject(token, params.slug);
        return text(JSON.stringify(result, null, 2));
      }
    );

    // 9. Generate Captions (orchestration tool with KV persistence)
    server.tool(
      "generate_captions",
      `Import a media file into Descript and generate captions. This starts the import and transcription process. All job IDs are cached for 24 hours so you can retrieve results later with get_cached_result or list_caption_jobs.`,
      generateCaptionsSchema,
      async (params, extra) => {
        const token = getToken(extra as any);
        const projectName = params.project_name || "Caption Generation";
        const captionId = crypto.randomUUID();
        const now = new Date().toISOString();

        // Step 1: Import the media
        const importResult = await client.importProjectMedia(token, {
          project_name: projectName,
          add_media: { media_1: { url: params.media_url } },
          add_compositions: [
            { name: "main", clips: [{ media: "media_1" }] },
          ],
        });

        // Create the caption job record in KV immediately
        const captionJob: CaptionJob = {
          id: captionId,
          media_url: params.media_url,
          project_name: projectName,
          import_job_id: importResult.job_id,
          project_id: importResult.project_id,
          project_url: importResult.project_url,
          status: "import_in_progress",
          created_at: now,
          updated_at: now,
        };
        await saveCaptionJob(captionJob);
        await mapJobIdToCaptionId(importResult.job_id, captionId);

        // Step 2: Quick poll
        const importJob = await pollJobUntilComplete(
          token,
          importResult.job_id,
          { maxAttempts: 5, intervalMs: 3000 }
        );

        if (!importJob) {
          return text(
            JSON.stringify(
              {
                status: "import_in_progress",
                message:
                  "Media import started but still processing. Use get_job_status with the import_job_id to check, or use list_caption_jobs / get_cached_result later to retrieve results.",
                caption_job_id: captionId,
                import_job_id: importResult.job_id,
                project_id: importResult.project_id,
                project_url: importResult.project_url,
              },
              null,
              2
            )
          );
        }

        // Cache the completed import job
        await cacheJobResult({
          ...importJob,
          cached_at: new Date().toISOString(),
        });

        if (importJob.job_state === "failed") {
          captionJob.status = "import_failed";
          captionJob.updated_at = new Date().toISOString();
          await saveCaptionJob(captionJob);
          return text(
            JSON.stringify(
              {
                status: "import_failed",
                message: "Media import failed.",
                caption_job_id: captionId,
                import_job: importJob,
              },
              null,
              2
            )
          );
        }

        // Step 3: Import done — kick off agent to export captions
        const agentResult = await client.createAgentJob(token, {
          project_id: importResult.project_id,
          prompt:
            "Export the transcript of this project. Output the full transcript text.",
        });

        // Update caption job with agent info
        captionJob.agent_job_id = agentResult.job_id;
        captionJob.status = "caption_export_started";
        captionJob.updated_at = new Date().toISOString();
        await saveCaptionJob(captionJob);
        await mapJobIdToCaptionId(agentResult.job_id, captionId);

        return text(
          JSON.stringify(
            {
              status: "caption_export_started",
              message:
                "Media imported and transcribed. Agent is exporting captions. Use get_job_status with agent_job_id to check, or list_caption_jobs / get_cached_result to retrieve later (cached for 24 hours).",
              caption_job_id: captionId,
              import_job_id: importResult.job_id,
              agent_job_id: agentResult.job_id,
              project_id: importResult.project_id,
              project_url: importResult.project_url,
            },
            null,
            2
          )
        );
      }
    );

    // 10. Get Cached Result
    server.tool(
      "get_cached_result",
      "Retrieve a cached job result or caption job by ID. Results are cached for 24 hours after a job completes. Accepts a Descript job_id or a caption_job_id from generate_captions.",
      getCachedResultSchema,
      async (params) => {
        // Try as a direct job cache hit
        const jobResult = await getCachedJobResult(params.job_id);
        if (jobResult) {
          return text(
            JSON.stringify(
              { ...jobResult, _source: "job_cache" },
              null,
              2
            )
          );
        }

        // Try as a caption job ID
        const captionJob = await getCaptionJob(params.job_id);
        if (captionJob) {
          return text(
            JSON.stringify(
              { ...captionJob, _source: "caption_job_cache" },
              null,
              2
            )
          );
        }

        // Try reverse lookup (maybe they passed an import/agent job_id)
        const captionByJob = await getCaptionJobByJobId(params.job_id);
        if (captionByJob) {
          return text(
            JSON.stringify(
              { ...captionByJob, _source: "caption_job_cache_via_job_id" },
              null,
              2
            )
          );
        }

        return text(
          JSON.stringify(
            {
              error: "not_found",
              message:
                "No cached result found for this ID. Results are only cached for 24 hours after job completion.",
            },
            null,
            2
          )
        );
      }
    );

    // 11. List Caption Jobs
    server.tool(
      "list_caption_jobs",
      "List recent caption generation jobs from the 24-hour cache. Shows job IDs, statuses, and whether captions are ready.",
      listCaptionJobsSchema,
      async (params) => {
        const limit = params.limit ?? 20;
        const jobs = await kvListCaptionJobs(limit);

        if (jobs.length === 0) {
          return text(
            JSON.stringify(
              {
                message: "No caption jobs found in the last 24 hours.",
                jobs: [],
              },
              null,
              2
            )
          );
        }

        return text(
          JSON.stringify(
            {
              count: jobs.length,
              jobs: jobs.map((j) => ({
                caption_job_id: j.id,
                media_url: j.media_url,
                project_name: j.project_name,
                status: j.status,
                has_captions: !!j.captions,
                import_job_id: j.import_job_id,
                agent_job_id: j.agent_job_id,
                project_id: j.project_id,
                project_url: j.project_url,
                created_at: j.created_at,
                updated_at: j.updated_at,
              })),
            },
            null,
            2
          )
        );
      }
    );
  },
  {},
  { basePath: "/api" }
);

// --- Wrap MCP handler with OAuth auth ---
const verifyToken = async (
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined;
  return {
    token: bearerToken,
    clientId: "descript-mcp",
    scopes: ["descript"],
  };
};

const authedMcpHandler = withMcpAuth(mcpHandler, verifyToken, {
  required: false,
});

// --- Main router ---
async function router(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/.well-known/oauth-protected-resource") {
    return handleProtectedResourceMetadata(req);
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return handleAuthServerMetadata(req);
  }
  if (path === "/oauth/register") {
    return handleRegister(req);
  }
  if (path === "/oauth/authorize") {
    return handleAuthorize(req);
  }
  if (path === "/oauth/token") {
    return handleToken(req);
  }

  return authedMcpHandler(req);
}

export { router as GET, router as POST, router as DELETE };
