import type { Context } from "hono";
import { JobContextSchema, type JobContext } from "../schemas/index.js";
import {
  validateJobContext,
  type ContextValidationResult,
} from "../services/contextValidationService.js";

const DESCRIPTION_KEYS = [
  "description",
  "jobDescription",
  "job_description",
  "taskDescription",
  "task_description",
  "workDescription",
  "work_description",
  "steps",
  "jobSteps",
  "job_steps",
];

function collectText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectText(item));
  }

  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function meaningfulDescriptionTerms(description?: string): string[] {
  if (!description) return [];
  const boilerplate = new Set(["step"]);
  return description
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((term) => term.length >= 3 && !/^\d+$/.test(term) && !boilerplate.has(term));
}

export function isIncompleteJobDescription(description?: string): boolean {
  return !!description?.trim() && meaningfulDescriptionTerms(description).length === 0;
}

export function normalizeJobContextInput(body: unknown): JobContext {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const descriptionParts = unique(
    DESCRIPTION_KEYS.flatMap((key) => collectText(input[key]))
  );

  const normalized = {
    ...input,
    jobType: input["jobType"] ?? input["workType"],
    description:
      descriptionParts.length > 0
        ? descriptionParts.join("\n")
        : input["description"],
  };

  return JobContextSchema.parse(normalized);
}

export function validateJobContextForResponse(
  jobContext: JobContext
): ContextValidationResult {
  return validateJobContext(jobContext);
}

export function invalidJobContextResponse(
  validation: ContextValidationResult,
  jobContext: JobContext
) {
  const keywords = unique(validation.incorrectKeywords.map((item) => item.keyword));
  const keywordList = keywords.join(", ");

  return {
    success: false,
    contextValid: false,
    error: "Invalid job description",
    message: `Please remove or replace unrelated keyword(s): ${keywordList}. Your description should describe the actual work activity, hazards, equipment, location, or controls.`,
    jobContext,
    incorrectKeywords: validation.incorrectKeywords,
    warnings: [
      `Incorrect keyword(s) detected: ${keywordList}. These terms are not related to permit-to-work, HSE, or oil and gas operations.`,
    ],
  };
}

export function incompleteJobDescriptionResponse(jobContext: JobContext) {
  return {
    success: false,
    contextValid: false,
    error: "Invalid job description",
    message:
      "Please enter a complete job description. The description should describe the actual work activity, hazards, equipment, location, or controls.",
    jobContext,
    incorrectKeywords: [],
    warnings: [
      "The job description is too short or incomplete for hazard assessment.",
    ],
  };
}

export function rejectInvalidJobContext(
  c: Context,
  jobContext: JobContext,
  validation: ContextValidationResult
) {
  if (isIncompleteJobDescription(jobContext.description)) {
    return c.json(incompleteJobDescriptionResponse(jobContext), 422);
  }

  if (validation.contextValid) return null;
  return c.json(invalidJobContextResponse(validation, jobContext), 422);
}
