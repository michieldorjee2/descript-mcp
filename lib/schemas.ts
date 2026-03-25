import { z } from "zod";

export const importProjectMediaSchema = {
  project_name: z.string().describe("Name for the new Descript project"),
  project_id: z
    .string()
    .uuid()
    .optional()
    .describe("Existing project ID to import into"),
  team_access: z
    .enum(["edit", "comment", "view", "none"])
    .optional()
    .describe("Team access level for the project"),
  add_media: z
    .record(
      z.string(),
      z.object({ url: z.string().url().describe("URL of the media file") })
    )
    .describe(
      "Map of media IDs to import items. Keys become references used in compositions."
    ),
  add_compositions: z
    .array(
      z.object({
        name: z.string().describe("Composition name"),
        clips: z
          .array(
            z.object({
              media: z
                .string()
                .describe("Media reference key from add_media"),
            })
          )
          .describe("Clips in this composition"),
      })
    )
    .optional()
    .describe("Compositions to create from imported media"),
  callback_url: z
    .string()
    .url()
    .optional()
    .describe("Webhook URL for job completion notification"),
};

export const agentJobSchema = {
  project_id: z
    .string()
    .uuid()
    .optional()
    .describe("Existing project ID to edit"),
  project_name: z
    .string()
    .optional()
    .describe("Name for a new project (if not editing existing)"),
  composition_id: z
    .string()
    .uuid()
    .optional()
    .describe("Specific composition within the project"),
  model: z.string().optional().describe("AI model selection"),
  prompt: z.string().describe("Natural language instruction for the agent"),
  team_access: z
    .enum(["edit", "comment", "view", "none"])
    .optional()
    .describe("Team access level for new projects"),
  callback_url: z
    .string()
    .url()
    .optional()
    .describe("Webhook URL for job completion notification"),
};

export const listJobsSchema = {
  project_id: z.string().uuid().optional().describe("Filter by project ID"),
  type: z
    .enum(["import/project_media", "agent"])
    .optional()
    .describe("Filter by job type"),
  cursor: z.string().optional().describe("Pagination cursor"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Results per page (1-100, default 20)"),
  created_after: z
    .string()
    .optional()
    .describe("Filter jobs created after this ISO-8601 timestamp"),
  created_before: z
    .string()
    .optional()
    .describe("Filter jobs created before this ISO-8601 timestamp"),
};

export const getJobSchema = {
  job_id: z.string().uuid().describe("Job ID to retrieve"),
};

export const cancelJobSchema = {
  job_id: z.string().uuid().describe("Job ID to cancel"),
};

export const editInDescriptSchema = {
  partner_drive_id: z
    .string()
    .uuid()
    .describe("Drive ID associated with your API token"),
  project_schema: z
    .object({
      schema_version: z
        .string()
        .default("1.0.0")
        .describe("Schema version"),
      source_id: z
        .string()
        .uuid()
        .optional()
        .describe("Partner source identifier"),
      files: z
        .array(
          z.object({
            uri: z.string().url().describe("Media file URI"),
            start_offset_seconds: z
              .number()
              .optional()
              .describe("Start offset in seconds"),
          })
        )
        .describe("Media files to import"),
    })
    .describe("Project schema containing files to import"),
};

export const getPublishedProjectSchema = {
  slug: z
    .string()
    .describe("URL slug of the published Descript project"),
};

export const generateCaptionsSchema = {
  media_url: z
    .string()
    .url()
    .describe(
      "URL of the media file to transcribe. Must support HTTP Range requests and be accessible for 12-48 hours."
    ),
  project_name: z
    .string()
    .optional()
    .describe("Name for the Descript project (defaults to 'Caption Generation')"),
};
