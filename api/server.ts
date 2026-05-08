import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import * as client from "../lib/descript-client.js";
import { DescriptApiError } from "../lib/descript-client.js";
import { pollJobUntilComplete } from "../lib/polling.js";
import { logger } from "../lib/logger.js";
import {
  importProjectMediaSchema,
  agentJobSchema,
  listJobsSchema,
  getJobSchema,
  cancelJobSchema,
  editInDescriptSchema,
  getPublishedProjectSchema,
  generateCaptionsSchema,
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
    throw new AuthError(
      "Missing Descript API token. Either use OAuth or set the x-descript-api-token header."
    );
  }
  return token;
}

// --- Error types ---
class AuthError extends Error {
  readonly type = "auth_error";
}

// --- Response helpers ---
function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function errorText(
  type: string,
  message: string,
  details?: unknown,
  requestId?: string
) {
  return text(
    JSON.stringify(
      {
        error_type: type,
        message,
        ...(details !== undefined ? { details } : {}),
        ...(requestId ? { request_id: requestId } : {}),
      },
      null,
      2
    )
  );
}

function handleToolError(err: unknown, toolName: string, requestId: string) {
  if (err instanceof AuthError) {
    logger.warn("tool_auth_error", { tool: toolName, message: err.message }, requestId);
    return errorText("auth_error", err.message, undefined, requestId);
  }
  if (err instanceof DescriptApiError) {
    const isClientError = err.status >= 400 && err.status < 500;
    logger.error(
      "tool_upstream_error",
      { tool: toolName, status: err.status, body: err.body },
      requestId
    );
    return errorText(
      isClientError ? "client_error" : "upstream_error",
      isClientError
        ? `Request rejected by Descript API (${err.status}). Check your parameters.`
        : `Descript API returned an error (${err.status}). Please try again later.`,
      { status: err.status, body: err.body },
      requestId
    );
  }
  logger.error(
    "tool_unexpected_error",
    { tool: toolName, error: String(err) },
    requestId
  );
  return errorText(
    "unexpected_error",
    "An unexpected error occurred. Please try again.",
    { error: String(err) },
    requestId
  );
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
        const requestId = crypto.randomUUID();
        logger.info("tool_called", { tool: "check_api_status" }, requestId);
        try {
          const token = getToken(extra as any);
          const result = await client.checkStatus(token, requestId);
          return text(JSON.stringify(result, null, 2));
        } catch (err) {
          return handleToolError(err, "check_api_status", requestId);
        }
      }
    );

    // 2. Import Project Media
    server.tool(
      "import_project_media",
      "Import media files into Descript, create projects, and establish compositions. Returns a job_id to track progress with get_job_status.",
      importProjectMediaSchema,
      async (params, extra) => {
        const requestId = crypto.randomUUID();
        logger.info("tool_called", { tool: "import_project_media" }, requestId);
        try {
          const token = getToken(extra as any);
          const result = await client.importProjectMedia(token, params, requestId);
          return text(JSON.stringify(result, null, 2));
        } catch (err) {
          return handleToolError(err, "import_project_media", requestId);
        }
      }
    );

    // 3. Run Agent
    server.tool(
      "run_agent",
      "Use the Descript AI agent to create or edit projects via natural language prompts. Returns a job_id to track progress.",
      agentJobSchema,
      async (params, extra) => {
        const requestId = crypto.randomUUID();
        logger.info("tool_called", { tool: "run_agent" }, requestId);
        try {
          const token = getToken(extra as any);
          const result = await client.createAgentJob(token, params, requestId);
          return text(JSON.stringify(result, null, 2));
        } catch (err) {
          return handleToolError(err, "run_agent", requestId);
        }
      }
    );

    // 4. List Jobs
    server.tool(
      "list_jobs",
      "List recent Descript jobs with optional filtering by project, type, and date range. Returns full result objects for completed jobs. Use this to find past job results.",
      listJobsSchema,
      async (params, extra) => {
        const requestId = crypto.randomUUID();
        logger.info("tool_called", { tool: "list_jobs" }, requestId);
        try {
          const token = getToken(extra as any);
          const result = await client.listJobs(token, params, requestId);
          return text(JSON.stringify(result, null, 2));
        } catch (err) {
          return handleToolError(err, "list_jobs", requestId);
        }
      }
    );

    // 5. Get Job Status
    server.tool(
      "get_job_status",
      "Get the current status and results of a Descript job. Use this to check on import or agent jobs. Returns full results for completed jobs.",
      getJobSchema,
      async (params, extra) => {
        const requestId = crypto.randomUUID();
        logger.info("tool_called", { tool: "get_job_status" }, requestId);
        try {
          const token = getToken(extra as any);
          const result = await client.getJob(token, params.job_id, requestId);
          return text(JSON.stringify(result, null, 2));
        } catch (err) {
          return handleToolError(err, "get_job_status", requestId);
        }
      }
    );

    // 6. Cancel Job
    server.tool(
      "cancel_job",
      "Cancel a running Descript job.",
      cancelJobSchema,
      async (params, extra) => {
        const requestId = crypto.randomUUID();
        logger.info("tool_called", { tool: "cancel_job" }, requestId);
        try {
          const token = getToken(extra as any);
          await client.cancelJob(token, params.job_id, requestId);
          return text(`Job ${params.job_id} cancelled.`);
        } catch (err) {
          return handleToolError(err, "cancel_job", requestId);
        }
      }
    );

    // 7. Generate Edit in Descript URL
    server.tool(
      "generate_edit_in_descript_url",
      "Generate a one-time-use URL to import content into the Descript editor (Edit in Descript integration).",
      editInDescriptSchema,
      async (params, extra) => {
        const requestId = crypto.randomUUID();
        logger.info("tool_called", { tool: "generate_edit_in_descript_url" }, requestId);
        try {
          const token = getToken(extra as any);
          const result = await client.generateEditInDescriptUrl(token, params, requestId);
          return text(JSON.stringify(result, null, 2));
        } catch (err) {
          return handleToolError(err, "generate_edit_in_descript_url", requestId);
        }
      }
    );

    // 8. Get Published Project
    server.tool(
      "get_published_project",
      "Get metadata and subtitles (WEBVTT format) for a published Descript project.",
      getPublishedProjectSchema,
      async (params, extra) => {
        const requestId = crypto.randomUUID();
        logger.info("tool_called", { tool: "get_published_project" }, requestId);
        try {
          const token = getToken(extra as any);
          const result = await client.getPublishedProject(token, params.slug, requestId);
          return text(JSON.stringify(result, null, 2));
        } catch (err) {
          return handleToolError(err, "get_published_project", requestId);
        }
      }
    );

    // 9. Generate Captions (orchestration tool)
    server.tool(
      "generate_captions",
      `Import a media file into Descript and generate captions. Starts import and transcription. If the job completes within ~3 minutes, also kicks off caption export via the AI agent. Returns job IDs — use get_job_status to check on them later, or list_jobs to find them by project_id.`,
      generateCaptionsSchema,
      async (params, extra) => {
        const requestId = crypto.randomUUID();
        logger.info("tool_called", { tool: "generate_captions" }, requestId);
        try {
          const token = getToken(extra as any);
          const projectName = params.project_name || "Caption Generation";

          // Step 1: Import the media
          const importResult = await client.importProjectMedia(
            token,
            {
              project_name: projectName,
              add_media: { media_1: { url: params.media_url } },
              add_compositions: [
                { name: "main", clips: [{ media: "media_1" }] },
              ],
            },
            requestId
          );

          logger.info(
            "generate_captions_import_started",
            { import_job_id: importResult.job_id, project_id: importResult.project_id },
            requestId
          );

          // Step 2: Poll up to ~3 minutes (20 × 10s) for import to complete
          const importJob = await pollJobUntilComplete(
            token,
            importResult.job_id,
            { maxAttempts: 20, intervalMs: 10_000 },
            requestId
          );

          if (!importJob) {
            logger.info(
              "generate_captions_import_still_running",
              { import_job_id: importResult.job_id },
              requestId
            );
            return text(
              JSON.stringify(
                {
                  status: "import_in_progress",
                  message:
                    "Media import started but is still processing after 3 minutes. Use get_job_status with the import_job_id to check progress. Once complete, use run_agent on the project to export captions.",
                  import_job_id: importResult.job_id,
                  project_id: importResult.project_id,
                  project_url: importResult.project_url,
                  request_id: requestId,
                },
                null,
                2
              )
            );
          }

          const importResultStatus = importJob.result?.["status"] as string | undefined;
          if (importJob.job_state === "failed" || importResultStatus === "error") {
            logger.warn(
              "generate_captions_import_failed",
              { import_job_id: importResult.job_id, job_state: importJob.job_state },
              requestId
            );
            return text(
              JSON.stringify(
                {
                  status: "import_failed",
                  message: "Media import failed.",
                  import_job: importJob,
                  request_id: requestId,
                },
                null,
                2
              )
            );
          }

          // Step 3: Import done — kick off agent to export captions
          const agentResult = await client.createAgentJob(
            token,
            {
              project_id: importResult.project_id,
              prompt:
                "Export the transcript of this project. Output the full transcript text.",
            },
            requestId
          );

          logger.info(
            "generate_captions_agent_started",
            { agent_job_id: agentResult.job_id, project_id: importResult.project_id },
            requestId
          );

          return text(
            JSON.stringify(
              {
                status: "caption_export_started",
                message:
                  "Media imported and transcribed. Agent is now exporting captions. Use get_job_status with the agent_job_id to check when captions are ready, or list_jobs to find all jobs for this project.",
                import_job_id: importResult.job_id,
                agent_job_id: agentResult.job_id,
                project_id: importResult.project_id,
                project_url: importResult.project_url,
                request_id: requestId,
              },
              null,
              2
            )
          );
        } catch (err) {
          return handleToolError(err, "generate_captions", requestId);
        }
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
