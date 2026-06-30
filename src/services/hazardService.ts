import { z } from "zod";
import { HazardSchema, type Hazard, type JobContext } from "../schemas/index.js";
import {
  validateJobContext,
  extractRelevanceTerms,
  InvalidJobContextError,
  type IncorrectKeyword,
} from "./contextValidationService.js";
import { chatCompletion, embedText } from "./embeddingService.js";
import { validateJobContextWithGemini } from "./aiContextValidationService.js";
import { VectorService, type VectorSearchResult } from "./vectorService.js";
import { env } from "../config.js";

const SYSTEM_INSTRUCTION = `You are an expert HSE AI assistant specialized in Nigerian oil & gas operations.
You are trained on IOGP safety standards and Nigerian DPR regulations.

Your role is to identify workplace hazards and suggest appropriate controls based on:
- Job type and context
- Historical incident data
- Industry best practices
- Nigerian regulatory requirements

Always prioritize worker safety and compliance. Provide specific, actionable recommendations.
Ignore any non-work-related or irrelevant text in the job description.`;

function buildHazardPrompt(
  context: JobContext,
  regulations: string,
  incidentSummary: string,
  complianceDocs: string,
  keywordWarning?: string
): string {
  return `Analyze this permit-to-work scenario and identify hazards:

JOB CONTEXT:
- Job Type: ${context.jobType}
- Location: ${context.location ?? "Not specified"}
- Environment: ${context.environment ?? "Not specified"}
- Equipment: ${(context.equipment ?? []).join(", ") || "Not specified"}
- Contractor: ${context.contractor?.name ?? "N/A"} (Tier ${context.contractor?.tier ?? "N/A"})
${context.description ? `- Description: ${context.description}` : ""}
${keywordWarning ?? ""}

RELEVANT REGULATIONS & WORK-TYPE PROFILES:
${regulations || "No specific regulations retrieved."}

SIMILAR HISTORICAL INCIDENTS:
${incidentSummary || "No similar incidents found."}

RELEVANT COMPLIANCE DOCUMENT EXCERPTS:
${complianceDocs || "No compliance document excerpts retrieved."}

TASK:
Generate 5-${env.MAX_HAZARD_SUGGESTIONS} potential hazards for this job. For each hazard, provide:
1. name: Clear hazard description
2. category: One of [chemical, physical, biological, ergonomic]
3. likelihood: Rating 1-5 (1=rare, 5=almost certain)
4. severity: Rating 1-5 (1=negligible, 5=catastrophic)
5. recommendedControls: Array of control objects. Each object must include:
   - name: Specific control measure
   - reductionPercent: Estimated risk reduction from 5-35 if this control is verified/approved
   - approved: false
6. regulatoryRefs: Array of applicable regulatory references. Include any that apply:
   - DPR EGASPIN (e.g. "DPR EGASPIN Section 4.1.2")
   - ISO 45001 (e.g. "ISO 45001:2018 Clause 8.1.3")
   - IOGP (e.g. "IOGP Report 459 Section 3.2")
   OMIT this field entirely if no specific regulation applies — do NOT use ["N/A"], ["none"], or any placeholder strings.
7. explanation: Brief rationale for why this hazard is relevant

CONSTRAINTS:
- Only suggest hazards directly relevant to the stated job type and work activity
- Do NOT invent hazards related to irrelevant or non-industrial topics
- Prefer controls from RELEVANT REGULATIONS when available
- Use higher reduction percentages for engineering/isolation controls than PPE/admin controls
- Do not mark any suggested control as approved; approval happens later during review
- Generate enough control measures so that, if all suggested controls are approved, the projected residual risk score is within ALARP (0-9)
- If a hazard starts high or critical, include stronger engineering/isolation controls before administrative controls or PPE
- Do not rely on PPE alone to bring high/critical hazards into ALARP

CRITICAL FOCUS AREAS:
- H₂S exposure in sour gas fields
- Confined space entry hazards
- Hot work in hydrocarbon environments
- SIMOPS (Simultaneous Operations) conflicts
- Dropped objects on offshore platforms

Return a JSON object with key "hazards" containing an array of hazard objects. No markdown, no explanations outside the JSON.`;
}

function formatRegulations(results: VectorSearchResult[]): string {
  if (results.length === 0) return "";
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${(r.payload["title"] as string) ?? "Regulation"}: ${(r.payload["content"] as string) ?? ""} (relevance: ${r.score.toFixed(2)})`
    )
    .join("\n");
}

function formatIncidents(results: VectorSearchResult[]): string {
  if (results.length === 0) return "";
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${(r.payload["description"] as string) ?? "Incident"} — Hazards: ${((r.payload["hazard_names"] as string[] | undefined)?.join(", ") ?? (r.payload["hazards"] as string) ?? "N/A")} (similarity: ${r.score.toFixed(2)})`
    )
    .join("\n");
}

function formatComplianceDocs(results: VectorSearchResult[]): string {
  if (results.length === 0) return "";
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${(r.payload["sourceFile"] as string) ?? "Document"} — ${(((r.payload["content"] as string) ?? (r.payload["text"] as string)) ?? "").slice(0, 400)} (relevance: ${r.score.toFixed(2)})`
    )
    .join("\n");
}

function mergeRegulationResults(
  exact: VectorSearchResult | null,
  semantic: VectorSearchResult[]
): VectorSearchResult[] {
  const merged: VectorSearchResult[] = [];
  const seen = new Set<string | number>();

  if (exact) {
    merged.push(exact);
    seen.add(exact.id);
  }

  for (const r of semantic) {
    if (seen.has(r.id)) continue;
    merged.push(r);
    seen.add(r.id);
    if (merged.length >= 5) break;
  }

  return merged;
}

const DPR_PLACEHOLDER = /^(n\/?a|none|null|not applicable|no reference|no ref)$/i;

function normalizeHazards(hazards: Hazard[]): Hazard[] {
  return hazards.map((h) => {
    if (!h.regulatoryRefs?.length) return h;
    const filtered = h.regulatoryRefs.filter((r) => !DPR_PLACEHOLDER.test(r.trim()));
    if (filtered.length === 0) {
      const { regulatoryRefs: _, ...rest } = h;
      return rest as Hazard;
    }
    return { ...h, regulatoryRefs: filtered };
  });
}

export interface HazardSuggestionResult {
  hazards: Hazard[];
  contextValid: boolean;
  incorrectKeywords: IncorrectKeyword[];
  warnings?: string[];
  promptTokens: number;
  completionTokens: number;
  regulationsUsed: number;
  incidentsUsed: number;
  complianceDocsUsed: number;
}

export class HazardService {
  private vectorService: VectorService;

  constructor() {
    this.vectorService = new VectorService();
  }

  async suggestHazards(context: JobContext): Promise<HazardSuggestionResult> {
    let validation = validateJobContext(context);
    validation = await validateJobContextWithGemini(context, validation);
    const { sanitizedContext, incorrectKeywords, contextValid } = validation;

    const warnings: string[] = [];
    if (!contextValid) {
      const flagged = incorrectKeywords.map((k) => `"${k.keyword}" (${k.field})`).join(", ");
      warnings.push(
        `Incorrect keyword(s) detected: ${flagged}. These terms were excluded from AI analysis. Please remove non-work-related text from the permit.`
      );
      console.warn(`[HazardService] Incorrect keywords flagged (warn mode): ${flagged}`);
      throw new InvalidJobContextError(
        `Invalid job description: incorrect keyword(s) detected: ${incorrectKeywords.map((k) => k.keyword).join(", ")}`,
        validation,
        context
      );
    }

    const keywordWarning = !contextValid
      ? `\nNOTE: Non-work-related terms were removed before analysis: ${incorrectKeywords.map((k) => k.keyword).join(", ")}. Do not generate hazards related to those terms.`
      : undefined;

    const contextText = [
      sanitizedContext.jobType,
      sanitizedContext.location ?? "",
      sanitizedContext.environment ?? "",
      ...(sanitizedContext.equipment ?? []),
      sanitizedContext.description ?? "",
    ]
      .join(" ")
      .trim();

    let queryVector: number[];
    try {
      queryVector = await embedText(contextText);
    } catch (error) {
      console.warn("[HazardService] Embedding failed, proceeding without vector search:", error);
      return this.suggestWithoutVectors(sanitizedContext, {
        contextValid,
        incorrectKeywords,
        warnings,
        keywordWarning,
      });
    }

    const threshold = env.HAZARD_CONFIDENCE_THRESHOLD;

    const [semanticRegulations, incidents, complianceDocs, exactProfile] = await Promise.all([
      this.vectorService.searchRegulations(queryVector, 5, threshold),
      this.vectorService.searchIncidents(queryVector, 5, threshold),
      this.vectorService.searchComplianceDocs(queryVector, 3, undefined, threshold),
      this.vectorService.findWorkTypeProfile(sanitizedContext.jobType),
    ]);

    const regulations = mergeRegulationResults(exactProfile, semanticRegulations);
    const regulationText = formatRegulations(regulations);
    const incidentText = formatIncidents(incidents);
    const complianceText = formatComplianceDocs(complianceDocs);

    const prompt = buildHazardPrompt(
      sanitizedContext,
      regulationText,
      incidentText,
      complianceText,
      keywordWarning
    );

    const result = await chatCompletion([
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user", content: prompt },
    ]);

    const parsed = JSON.parse(result.content);
    const hazardsArray = z.array(HazardSchema);
    let hazards = normalizeHazards(hazardsArray.parse(parsed.hazards));
    const aiHazardsBeforeFilter = [...hazards];

    hazards = this.mergeIncidentHazards(hazards, incidents);
    hazards = this.filterIrrelevantHazards(hazards, sanitizedContext, regulations);

    if (hazards.length === 0 && aiHazardsBeforeFilter.length > 0) {
      console.warn("[HazardService] Post-filter removed all hazards — keeping AI output");
      hazards = aiHazardsBeforeFilter;
    }

    return {
      hazards,
      contextValid,
      incorrectKeywords,
      warnings: warnings.length > 0 ? warnings : undefined,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      regulationsUsed: regulations.length,
      incidentsUsed: incidents.length,
      complianceDocsUsed: complianceDocs.length,
    };
  }

  private async suggestWithoutVectors(
    context: JobContext,
    meta: {
      contextValid: boolean;
      incorrectKeywords: IncorrectKeyword[];
      warnings: string[];
      keywordWarning?: string;
    }
  ): Promise<HazardSuggestionResult> {
    const prompt = buildHazardPrompt(context, "", "", "", meta.keywordWarning);

    const result = await chatCompletion([
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user", content: prompt },
    ]);

    const parsed = JSON.parse(result.content);
    const hazardsArray = z.array(HazardSchema);
    let hazards = normalizeHazards(hazardsArray.parse(parsed.hazards));
    hazards = this.filterIrrelevantHazards(hazards, context, []);

    return {
      hazards,
      contextValid: meta.contextValid,
      incorrectKeywords: meta.incorrectKeywords,
      warnings: meta.warnings.length > 0 ? meta.warnings : undefined,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      regulationsUsed: 0,
      incidentsUsed: 0,
      complianceDocsUsed: 0,
    };
  }

  private readonly INCIDENT_SIMILARITY_THRESHOLD = 0.70;
  private readonly MAX_MERGED_FROM_INCIDENTS = 5;

  private readonly OUTCOME_TERMS = new Set([
    "serious injury",
    "injury",
    "fatality",
    "death",
    "incident",
  ]);

  private readonly CHEMICAL_KEYWORDS = [
    "gas", "vapor", "vapour", "chemical", "h2s", "co", "oxygen",
    "toxic", "flammable", "explosive", "lel", "fume", "asphyxia",
    "asphyxiation", "atmosphere", "atmospheric",
  ];

  private readonly BLOCKLIST_HAZARD_TERMS = new Set([
    "love", "rice", "pizza", "movie", "game", "football", "shopping", "romance",
  ]);

  private inferCategory(hazardName: string): Hazard["category"] {
    const lower = hazardName.toLowerCase();
    if (this.CHEMICAL_KEYWORDS.some((kw) => lower.includes(kw))) {
      return "chemical";
    }
    return "physical";
  }

  private isDuplicate(candidate: string, existingNames: Set<string>): boolean {
    const lower = candidate.toLowerCase();
    if (existingNames.has(lower)) return true;

    const STOP_WORDS = new Set(["from", "with", "that", "this", "into", "over", "under", "and", "the"]);
    const candidateWords = lower
      .split(/[\s/(),]+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

    for (const existing of existingNames) {
      if (existing.includes(lower) || lower.includes(existing)) return true;

      const existingWords = existing
        .split(/[\s/(),]+/)
        .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

      if (candidateWords.length === 0) continue;
      const overlap = candidateWords.filter((w) => existingWords.includes(w)).length;
      if (overlap / candidateWords.length > 0.5) return true;
    }

    return false;
  }

  private isOutcomeTerm(hazardName: string): boolean {
    return this.OUTCOME_TERMS.has(hazardName.toLowerCase());
  }

  /**
   * Drop hazards that contain blocklisted terms or have no overlap with job context / regulations.
   */
  private filterIrrelevantHazards(
    hazards: Hazard[],
    context: JobContext,
    regulations: VectorSearchResult[]
  ): Hazard[] {
    const relevanceTerms = extractRelevanceTerms(context);

    for (const reg of regulations) {
      const regHazards = reg.payload["hazards"] as string[] | undefined;
      if (regHazards) {
        for (const h of regHazards) {
          for (const token of h.toLowerCase().split(/[\s/(),]+/)) {
            if (token.length >= 3) relevanceTerms.add(token);
          }
        }
      }
    }

    const STOP = new Set(["from", "with", "during", "risk", "hazard", "potential"]);

    return hazards.filter((hazard) => {
      const nameLower = hazard.name.toLowerCase();
      const nameTokens = nameLower.split(/[\s/(),]+/).filter((t) => t.length >= 3);

      if (nameTokens.some((t) => this.BLOCKLIST_HAZARD_TERMS.has(t))) {
        console.warn(`[HazardService] Filtered irrelevant hazard: "${hazard.name}"`);
        return false;
      }

      const significant = nameTokens.filter((t) => !STOP.has(t));
      if (significant.length === 0) return true;

      const hasOverlap = significant.some((t) => relevanceTerms.has(t) || nameLower.includes(t));
      if (!hasOverlap) {
        // Allow if hazard shares a stem with job type words (e.g. "weld" / "welding")
        const jobWords = context.jobType.toLowerCase().split(/[\s/()-]+/);
        const jobMatch = significant.some((t) =>
          jobWords.some((jw) => jw.includes(t) || t.includes(jw))
        );
        if (!jobMatch) {
          console.warn(`[HazardService] Filtered low-relevance hazard: "${hazard.name}"`);
          return false;
        }
      }

      return true;
    });
  }

  private mergeIncidentHazards(
    aiHazards: Hazard[],
    incidents: VectorSearchResult[]
  ): Hazard[] {
    const existingNames = new Set(aiHazards.map((h) => h.name.toLowerCase()));
    let mergedCount = 0;

    for (const incident of incidents) {
      if (incident.score < this.INCIDENT_SIMILARITY_THRESHOLD) continue;

      const incidentHazards = incident.payload["hazard_names"] as string[] | undefined;
      if (!incidentHazards) continue;

      for (const hazardName of incidentHazards) {
        if (mergedCount >= this.MAX_MERGED_FROM_INCIDENTS) break;
        if (this.isOutcomeTerm(hazardName)) continue;
        if (this.isDuplicate(hazardName, existingNames)) continue;

        existingNames.add(hazardName.toLowerCase());
        mergedCount++;

        aiHazards.push({
          name: hazardName,
          category: this.inferCategory(hazardName),
          likelihood: 2,
          severity: 3,
          recommendedControls: ["Review historical incident data for specific controls"],
          explanation: `Identified from similar historical incident (similarity: ${incident.score.toFixed(2)}). Requires manual review.`,
        });
      }

      if (mergedCount >= this.MAX_MERGED_FROM_INCIDENTS) break;
    }

    return aiHazards;
  }
}
