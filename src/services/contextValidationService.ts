import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import type { JobContext } from "../schemas/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface IncorrectKeyword {
  keyword: string;
  field: string;
  flag: "incorrect_keyword";
  reason: string;
}

export interface ContextValidationResult {
  /** False when one or more incorrect keywords were detected */
  contextValid: boolean;
  incorrectKeywords: IncorrectKeyword[];
  /** Context with flagged tokens removed from text fields (used for RAG / embedding) */
  sanitizedContext: JobContext;
}

interface LexiconData {
  blocklist: string[];
  commonPermitWords: string[];
  hseTerms: string[];
}

const REASON_BLOCKLIST =
  "Term is not related to permit-to-work, HSE, or oil & gas operations";
const REASON_UNKNOWN =
  "Term is not recognized as HSE, permit-to-work, or industry vocabulary";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

function buildDomainVocabulary(): Set<string> {
  const vocab = new Set<string>();

  const lexicon: LexiconData = JSON.parse(
    readFileSync(path.join(__dirname, "../data/hseLexicon.json"), "utf-8")
  );

  for (const word of [...lexicon.commonPermitWords, ...lexicon.hseTerms]) {
    vocab.add(word.toLowerCase());
  }

  try {
    const riskData = JSON.parse(
      readFileSync(path.join(__dirname, "../../workTypeRiskData.json"), "utf-8")
    ) as {
      WorkTypeRiskAssessment: Array<{
        workType: string;
        hazards: string[];
        controlMeasures: string[];
        permitType: string;
        typicalArea: string;
        recommendation: string;
      }>;
    };

    for (const entry of riskData.WorkTypeRiskAssessment) {
      for (const text of [
        entry.workType,
        entry.permitType,
        entry.typicalArea,
        entry.recommendation,
        ...entry.hazards,
        ...entry.controlMeasures,
      ]) {
        for (const token of tokenize(text)) {
          if (token.length >= 2) vocab.add(token);
        }
      }
    }
  } catch (error) {
    console.warn("[ContextValidationService] Could not load workTypeRiskData.json:", error);
  }

  return vocab;
}

const LEXICON: LexiconData = JSON.parse(
  readFileSync(path.join(__dirname, "../data/hseLexicon.json"), "utf-8")
);
const BLOCKLIST = new Set(LEXICON.blocklist.map((w) => w.toLowerCase()));
const COMMON_WORDS = new Set(LEXICON.commonPermitWords.map((w) => w.toLowerCase()));
const DOMAIN_VOCAB = buildDomainVocabulary();

function isAllowedToken(token: string): boolean {
  const lower = token.toLowerCase();
  if (lower.length < 3) return true;
  if (/^\d+$/.test(lower)) return true;
  if (BLOCKLIST.has(lower)) return false;
  if (COMMON_WORDS.has(lower)) return true;
  if (DOMAIN_VOCAB.has(lower)) return true;
  return false;
}

function stripTokens(text: string, tokensToRemove: Set<string>): string {
  if (tokensToRemove.size === 0) return text;
  let result = text;
  for (const token of tokensToRemove) {
    const pattern = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    result = result.replace(pattern, " ");
  }
  return result.replace(/\s{2,}/g, " ").trim();
}

type ValidationMode = "strict" | "blocklist-only";

function validateField(
  field: string,
  value: string,
  flagged: IncorrectKeyword[],
  tokensToStrip: Set<string>,
  mode: ValidationMode
): string {
  const seen = new Set<string>();

  for (const token of tokenize(value)) {
    if (seen.has(token)) continue;
    seen.add(token);

    if (BLOCKLIST.has(token)) {
      flagged.push({
        keyword: token,
        field,
        flag: "incorrect_keyword",
        reason: REASON_BLOCKLIST,
      });
      tokensToStrip.add(token);
      continue;
    }

    // Strict mode applies domain vocabulary only to free-text description fields.
    // Location names, equipment models, and work types must not be rejected as unknown.
    if (mode === "strict" && !isAllowedToken(token)) {
      flagged.push({
        keyword: token,
        field,
        flag: "incorrect_keyword",
        reason: REASON_UNKNOWN,
      });
      tokensToStrip.add(token);
    }
  }

  return stripTokens(value, tokensToStrip);
}

/**
 * Validates permit job context for off-topic / non-HSE keywords.
 * WARN mode: returns flags but supplies a sanitized context for AI/RAG.
 */
export function validateJobContext(context: JobContext): ContextValidationResult {
  const incorrectKeywords: IncorrectKeyword[] = [];
  const tokensToStrip = new Set<string>();

  const sanitized: JobContext = { ...context };

  sanitized.jobType = validateField(
    "jobType",
    context.jobType,
    incorrectKeywords,
    tokensToStrip,
    "blocklist-only"
  );

  if (context.location) {
    sanitized.location = validateField(
      "location",
      context.location,
      incorrectKeywords,
      tokensToStrip,
      "blocklist-only"
    );
  }

  if (context.environment) {
    sanitized.environment = validateField(
      "environment",
      context.environment,
      incorrectKeywords,
      tokensToStrip,
      "blocklist-only"
    );
  }

  if (context.description) {
    sanitized.description = validateField(
      "description",
      context.description,
      incorrectKeywords,
      tokensToStrip,
      "strict"
    );
  }

  if (context.equipment?.length) {
    sanitized.equipment = context.equipment.map((item, index) =>
      validateField(
        `equipment[${index}]`,
        item,
        incorrectKeywords,
        tokensToStrip,
        "blocklist-only"
      )
    );
  }

  // Deduplicate flags by keyword+field
  const deduped = incorrectKeywords.filter(
    (item, index, arr) =>
      arr.findIndex((x) => x.keyword === item.keyword && x.field === item.field) === index
  );

  return {
    contextValid: deduped.length === 0,
    incorrectKeywords: deduped,
    sanitizedContext: sanitized,
  };
}

/** Collect significant terms from context for hazard relevance checks */
export function extractRelevanceTerms(context: JobContext): Set<string> {
  const terms = new Set<string>();
  const parts = [
    context.jobType,
    context.location ?? "",
    context.environment ?? "",
    context.description ?? "",
    ...(context.equipment ?? []),
  ];

  for (const part of parts) {
    for (const token of tokenize(part)) {
      if (token.length >= 3 && isAllowedToken(token)) {
        terms.add(token);
      }
    }
  }

  for (const token of tokenize(context.jobType)) {
    if (token.length >= 2) terms.add(token);
  }

  return terms;
}
