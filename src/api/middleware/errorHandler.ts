import type { Context, Next } from "hono";
import { ZodError } from "zod";
import { AIUnavailableError } from "../../services/embeddingService.js";
import { InvalidJobContextError } from "../../services/contextValidationService.js";

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (error) {
    if (error instanceof ZodError) {
      return c.json(
        {
          success: false,
          error: "Invalid request body",
          details: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        },
        400
      );
    }
    if (error instanceof InvalidJobContextError) {
      const keywords = unique(error.validation.incorrectKeywords.map((item) => item.keyword));
      const keywordList = keywords.join(", ");
      return c.json(
        {
          success: false,
          contextValid: false,
          error: "Invalid job description",
          message: `Please remove or replace unrelated keyword(s): ${keywordList}. Your description should describe the actual work activity, hazards, equipment, location, or controls.`,
          jobContext: error.jobContext,
          incorrectKeywords: error.validation.incorrectKeywords,
          warnings: [
            `Incorrect keyword(s) detected: ${keywordList}. These terms are not related to permit-to-work, HSE, or oil and gas operations.`,
          ],
        },
        422
      );
    }
    if (error instanceof AIUnavailableError) {
      console.error("[API] AI service unavailable:", error.message);
      return c.json(
        { success: false, error: "AI service temporarily unavailable. Rule-based checks completed but AI enrichment failed." },
        503
      );
    }
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred";
    console.error("[API] Error:", message);
    return c.json({ success: false, error: message }, 500);
  }
}
