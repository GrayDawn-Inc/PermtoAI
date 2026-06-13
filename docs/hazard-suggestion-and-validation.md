# Hazard Suggestion & Context Validation

This document explains how PermitoAI identifies hazards, validates permit input, and the improvements added to increase suggestion quality and flag off-topic keywords.

> **Guiding principle:** *AI assists, rules constrain, humans decide, logs remember.*

---

## Overview

PermitoAI hazard suggestion is a **RAG + LLM pipeline**:

```
JobContext (API input)
        │
        ▼
ContextValidationService     ← keyword check (warn mode)
        │
        ▼
Sanitized JobContext         ← bad terms stripped from embedding text
        │
        ▼
Embed query (Gemini) ──► Qdrant vector search (parallel)
        │                      ├─ work-type regulations
        │                      ├─ historical incidents
        │                      └─ compliance PDF chunks
        ▼
Gemini hazard prompt         ← grounded context + constraints
        │
        ▼
Post-processing              ← normalize refs, merge incidents, filter junk
        │
        ▼
HazardSuggestionResult       ← hazards + warnings + metadata
```

The same core logic is used by:

- `POST /api/v1/tools/hazard-suggest`
- MCP tool `HAZARD_SUGGEST`
- Agent workflows: `full-assessment`, `quick-assess`, `simops-assess`

---

## Part 1 — Context validation (incorrect keywords)

### Purpose

Permit free-text fields can contain irrelevant content (e.g. `"love"`, `"rice"`, social/food terms). These terms:

- Skew vector search (RAG retrieves wrong context)
- Can cause the LLM to hallucinate unrelated hazards

**Context validation** detects off-topic tokens **before** embedding and AI calls.

### Mode: WARN (current behaviour)

| Behaviour | Description |
|-----------|-------------|
| Request proceeds | Hazards are still returned (`success: true`) |
| `contextValid: false` | One or more incorrect keywords were found |
| `incorrectKeywords[]` | Structured list of flagged terms |
| `warnings[]` | Human-readable summary for the UI |
| Sanitized context | Flagged tokens are **removed** from text used for embedding/RAG |

The original request body is not modified in the response — only the internal analysis uses sanitized text.

### What gets scanned

| Field | Validation level |
|-------|------------------|
| `description` | **Strict** — blocklist + HSE domain vocabulary |
| `jobType` | Blocklist only |
| `location` | Blocklist only (place names like "Bonny", "Warri" are allowed) |
| `environment` | Blocklist only |
| `equipment[]` | Blocklist only (model names like "XR-500" are allowed) |
| `contractor.name` | **Not scanned** (company names may contain arbitrary words) |

### Two-layer token check

**Layer A — Blocklist (all scanned fields)**

Hard-coded non-work terms in `src/data/hseLexicon.json` → `blocklist`:

- Food/lifestyle: `love`, `rice`, `pizza`, `dinner`, …
- Entertainment, social media, gambling, etc.

Each match returns:

```json
{
  "keyword": "rice",
  "field": "description",
  "flag": "incorrect_keyword",
  "reason": "Term is not related to permit-to-work, HSE, or oil & gas operations"
}
```

**Layer B — Domain vocabulary (description only)**

Tokens ≥ 3 characters must appear in the HSE vocabulary, built from:

1. `src/data/hseLexicon.json` → `commonPermitWords`, `hseTerms`
2. All tokens extracted from `workTypeRiskData.json` (work types, hazards, controls, areas)

Unknown tokens in **description** are flagged with:

> *Term is not recognized as HSE, permit-to-work, or industry vocabulary*

### Configuration

Extend validation without code changes by editing `src/data/hseLexicon.json`:

```json
{
  "blocklist": ["love", "rice", "..."],
  "commonPermitWords": ["work", "repair", "..."],
  "hseTerms": ["weld", "loto", "h2s", "..."]
}
```

Restart the API after editing.

### Tests

Run unit tests:

```bash
pnpm test
# or
npx tsx src/tests/contextValidation.test.ts
```

---

## Part 2 — Hazard suggestion improvements

### 1. RAG relevance threshold

Previously, Qdrant returned top-5 results regardless of similarity score.

Now `HAZARD_CONFIDENCE_THRESHOLD` (default **0.7**, env-configurable) is applied to:

- Regulation / work-type profiles
- Historical incidents
- Compliance document chunks

Low-relevance vectors are excluded from the prompt, reducing noise.

```env
HAZARD_CONFIDENCE_THRESHOLD=0.7
```

### 2. Exact work-type profile injection

When `jobType` exactly matches a seeded entry in Qdrant (from `workTypeRiskData.json`), that profile is **always** injected as the first regulation context — even if semantic search ranks it lower.

This stabilises suggestions for known permit types like `"Hot Work - Welding/Cutting"`.

### 3. Compliance document RAG

If `pnpm ingest` has been run, hazard suggestion also searches the `permito_compliance_docs` collection (ingested NUPRC/IOGP PDFs) and includes relevant excerpts in the prompt.

Response metadata includes `complianceDocsUsed`.

### 4. Stronger LLM prompt constraints

The hazard prompt now instructs Gemini to:

- Only suggest hazards relevant to the stated job type
- Ignore non-work-related text
- Prefer controls from retrieved regulations
- Omit placeholder regulatory references

When incorrect keywords were detected, an extra note is injected telling the model not to generate hazards for those terms.

### 5. Incident merge guardrail (existing, fixed)

Similar incidents above **0.70** similarity can add hazards the AI missed. The incident formatter now correctly reads `hazard_names` from Qdrant payloads (seed format).

### 6. Post-filter for irrelevant hazards

After AI generation, hazards are dropped if they:

- Contain blocklisted terms in the hazard name (e.g. AI invents a "rice contamination" hazard)
- Have no vocabulary overlap with the job context, work type, or retrieved regulation hazards

**Safety net:** if the filter would remove *all* hazards, the original AI output is kept.

---

## Part 3 — Data sources

| Source | Collection | Purpose |
|--------|------------|---------|
| `workTypeRiskData.json` | `permitoai` (seed) | Work-type risk profiles for RAG + domain vocab |
| Synthetic incidents | `permito_incidents` (seed) | Historical hazard patterns |
| `compliance_docs/*.pdf` | `permito_compliance_docs` (ingest) | Regulatory grounding |

Seed and ingest commands:

```bash
pnpm seed      # required before hazard suggest
pnpm ingest    # recommended for compliance RAG
```

---

## Part 4 — Response fields (hazard suggest)

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Request completed without server error |
| `contextValid` | boolean | `true` if no incorrect keywords detected |
| `incorrectKeywords` | array | Flagged terms (empty when valid) |
| `warnings` | string[]? | Present when keywords were flagged |
| `hazardCount` | number | Number of hazards returned |
| `hazards` | Hazard[] | AI-generated hazard list |
| `metadata.regulationsUsed` | number | Regulation vectors used in prompt |
| `metadata.incidentsUsed` | number | Incident vectors used in prompt |
| `metadata.complianceDocsUsed` | number | Compliance chunks used in prompt |
| `metadata.promptTokens` | number | Gemini input tokens |
| `metadata.completionTokens` | number | Gemini output tokens |

---

## Part 5 — Risk scoring (downstream)

After hazard suggestion, `RISK_ASSESS` applies **deterministic severity floors** (e.g. H₂S ≥ 4, asphyxiation ≥ 5). AI cannot score below these minimums.

See `src/services/riskScoringService.ts` for the full rule table.

---

## Architecture diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        HAZARD_SUGGEST                           │
├─────────────────────────────────────────────────────────────────┤
│  Input: JobContext                                              │
│                                                                 │
│  ┌──────────────────────┐                                       │
│  │ ContextValidation    │  blocklist + domain vocab (desc)      │
│  │ (warn mode)          │  → incorrectKeywords, sanitized ctx   │
│  └──────────┬───────────┘                                       │
│             ▼                                                   │
│  ┌──────────────────────┐     ┌─────────────────────────────┐  │
│  │ embedText(sanitized) │────►│ Qdrant (score ≥ 0.7)        │  │
│  └──────────────────────┘     │  • regulations + exact match │  │
│                               │  • incidents                 │  │
│                               │  • compliance docs           │  │
│                               └──────────────┬──────────────┘  │
│                                              ▼                  │
│                               ┌─────────────────────────────┐  │
│                               │ Gemini (temp=0, JSON mode)  │  │
│                               └──────────────┬──────────────┘  │
│                                              ▼                  │
│                               normalize → merge → filter        │
│                                              ▼                  │
│  Output: hazards + warnings + metadata                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Related files

| File | Role |
|------|------|
| `src/services/contextValidationService.ts` | Keyword validation & sanitization |
| `src/services/hazardService.ts` | RAG + AI hazard pipeline |
| `src/services/vectorService.ts` | Qdrant search with score thresholds |
| `src/data/hseLexicon.json` | Blocklist and HSE vocabulary |
| `workTypeRiskData.json` | Seed data + domain vocab source |
| `src/tests/contextValidation.test.ts` | Unit tests |

For HTTP request/response examples see [api-reference.md](./api-reference.md).
