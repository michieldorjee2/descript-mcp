import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import * as client from "../lib/descript-client.js";
import { pollJobUntilComplete } from "../lib/polling.js";
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
// Tries authInfo first (from OAuth flow), then falls back to header (direct usage)
function getToken(extra: any): string {
  // OAuth flow: token comes via authInfo from withMcpAuth
  const authToken = extra?.authInfo?.token;
  if (authToken) return authToken;

  // Fallback: direct header (for non-OAuth clients)
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

    // 5. Get Job Status
    server.tool(
      "get_job_status",
      "Get the current status and results of a Descript job. Use this to check on import or agent jobs.",
      getJobSchema,
      async (params, extra) => {
        const token = getToken(extra as any);
        const result = await client.getJob(token, params.job_id);
        return text(JSON.stringify(result, null, 2));
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

    // 9. Generate Captions (orchestration tool)
    server.tool(
      "generate_captions",
      `Import a media file into Descript and generate captions. This starts the import and transcription process. If the job completes quickly, it will also kick off caption export via the AI agent. If not, it returns job IDs so you can check back with get_job_status.`,
      generateCaptionsSchema,
      async (params, extra) => {
        const token = getToken(extra as any);
        const projectName = params.project_name || "Caption Generation";

        // Step 1: Import the media
        const importResult = await client.importProjectMedia(token, {
          project_name: projectName,
          add_media: { media_1: { url: params.media_url } },
          add_compositions: [
            { name: "main", clips: [{ media: "media_1" }] },
          ],
        });

        // Step 2: Quick poll - try a few times, don't block long
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
                  "Media import started but still processing. Use get_job_status to check when it completes, then use run_agent to export captions.",
                import_job_id: importResult.job_id,
                project_id: importResult.project_id,
                project_url: importResult.project_url,
              },
              null,
              2
            )
          );
        }

        const importStatus = (importJob.result as any)?.status;
        if (importJob.job_state === "failed" || importStatus === "error") {
          return text(
            JSON.stringify(
              {
                status: "import_failed",
                message: "Media import failed.",
                import_job: importJob,
              },
              null,
              2
            )
          );
        }

        // Step 3: Import done - kick off agent to export subtitles
        const agentResult = await client.createAgentJob(token, {
          project_id: importResult.project_id,
          prompt:
            "Export the transcript of this project. Output the full transcript text.",
        });

        return text(
          JSON.stringify(
            {
              status: "caption_export_started",
              message:
                "Media imported and transcribed. Agent is now exporting captions. Use get_job_status with the agent_job_id to check when captions are ready.",
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
  },
  {},
  { basePath: "/api" }
);

// --- Wrap MCP handler with OAuth auth (optional - not required) ---
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

// --- Main router: OAuth endpoints + MCP ---
async function router(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // OAuth discovery & endpoints
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

  // Everything else -> MCP handler (with optional auth)
  return authedMcpHandler(req);
}

export { router as GET, router as POST, router as DELETE };
