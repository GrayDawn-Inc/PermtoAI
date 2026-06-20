import { z } from "zod";
import type { JobContext } from "../schemas/index.js";
import { chatCompletion } from "./embeddingService.js";
import type {
  ContextValidationResult,
  IncorrectKeyword,
} from "./contextValidationService.js";

const AiContextValidationSchema = z.object({
  contextValid: z.boolean(),
  incorrectKeywords: z.array(
    z.object({
      keyword: z.string(),
      reason: z.string(),
    })
  ).default([]),
});

const REASON_AI =
  "Gemini classified this term or phrase as unrelated to permit-to-work, HSE, oil and gas operations, or the stated work activity";

function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

function toIncorrectKeywords(items: Array<{ keyword: string; reason?: string }>): IncorrectKeyword[] {
  const seen = new Set<string>();
  const result: IncorrectKeyword[] = [];

  for (const item of items) {
    const keyword = normalizeKeyword(item.keyword);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    result.push({
      keyword,
      field: "description",
      flag: "incorrect_keyword",
      reason: item.reason?.trim() || REASON_AI,
    });
  }

  return result;
}

export async function validateJobContextWithGemini(
  context: JobContext,
  localValidation: ContextValidationResult
): Promise<ContextValidationResult> {
  if (!localValidation.contextValid || !context.description?.trim()) {
    return localValidation;
  }

  const result = await chatCompletion([
    {
      role: "system",
      content: `You validate permit-to-work job descriptions for Nigerian oil and gas HSE workflows.

Accept normal work sentences, comma-separated phrases, and short task keywords when they relate to:
- work preparation, area preparation, housekeeping, cleaning the work environment
- hazards, controls, isolation, inspection, maintenance, repair, equipment, location, access, PPE, gas testing
- the stated work type, even if the wording is not in a fixed dictionary

Reject only terms or phrases that are clearly unrelated to work, HSE, permit-to-work, oil and gas operations, or industrial safety.

Return JSON only:
{
  "contextValid": boolean,
  "incorrectKeywords": [{ "keyword": string, "reason": string }]
}`,
    },
    {
      role: "user",
      content: `Work type: ${context.jobType}
Location: ${context.location ?? "Not specified"}
Environment: ${context.environment ?? "Not specified"}
Equipment: ${(context.equipment ?? []).join(", ") || "Not specified"}
Description: ${context.description}`,
    },
  ]);

  let parsed: z.infer<typeof AiContextValidationSchema>;
  try {
    parsed = AiContextValidationSchema.parse(JSON.parse(result.content));
  } catch (error) {
    console.warn("[ContextValidation] Gemini validation response could not be parsed:", error);
    return localValidation;
  }

  if (parsed.contextValid) {
    return localValidation;
  }

  const aiKeywords = toIncorrectKeywords(parsed.incorrectKeywords);
  if (aiKeywords.length === 0) {
    return localValidation;
  }

  return {
    contextValid: false,
    incorrectKeywords: aiKeywords,
    sanitizedContext: localValidation.sanitizedContext,
  };
}
