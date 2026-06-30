# PermitoAI REST API Reference

Complete reference for the PermitoAI REST API (port **4000** by default).

For hazard suggestion logic and keyword validation, see [hazard-suggestion-and-validation.md](./hazard-suggestion-and-validation.md).

---

## Base URL

```
http://localhost:4000
```

Configure with environment variable `API_PORT`.

---

## Headers (all endpoints)

| Header | Value | Required |
|--------|-------|----------|
| `Content-Type` | `application/json` | Yes (POST/PUT/PATCH bodies) |
| `Accept` | `application/json` | Optional |
| `Authorization` | `Bearer <token>` | Optional (not enforced by PermitoAI today; ePTW proxy may require it) |

### Example request headers

```http
POST /api/v1/tools/hazard-suggest HTTP/1.1
Host: localhost:4000
Content-Type: application/json
Accept: application/json
```

### CORS

The API allows all origins (`Access-Control-Allow-Origin: *`). Preflight `OPTIONS` is supported.

---

## Response envelope

All successful responses include `"success": true`.

Error responses:

```json
// 400 — Zod validation failure
{
  "success": false,
  "error": "Invalid request body",
  "details": ["jobType: Required"]
}

// 404
{
  "success": false,
  "error": "Route not found: /api/v1/unknown"
}

// 500
{
  "success": false,
  "error": "No text returned from Gemini"
}
```

---

## Health

### `GET /api/v1/health`

No request body.

**Example**

```bash
curl -s http://localhost:4000/api/v1/health
```

**Response `200`**

```json
{
  "success": true,
  "status": "ok",
  "service": "PermitoAI REST API",
  "version": "1.0.0",
  "timestamp": "2026-06-12T10:00:00.000Z",
  "tools": [
    "HAZARD_SUGGEST",
    "RISK_ASSESS",
    "COMPLIANCE_CHECK",
    "PERMIT_VALIDATE",
    "ANOMALY_DETECT",
    "SIMOPS_CHECK"
  ]
}
```

---

## Tools

Base path: `/api/v1/tools`

---

### `POST /api/v1/tools/hazard-suggest`

AI hazard identification with RAG over regulations, incidents, and compliance docs. Includes **incorrect keyword validation (warn mode)**.

**Request body — `JobContext`**

```json
{
  "jobType": "Hot Work - Welding/Cutting",
  "location": "Bonny Terminal, Rivers State",
  "environment": "Onshore crude oil processing facility",
  "equipment": ["Welding machine", "Angle grinder", "Gas detector", "Fire extinguisher"],
  "contractor": {
    "name": "SafeWeld Nigeria Ltd",
    "tier": 2
  },
  "description": "Welding repair on crude oil pipeline flange. Adjacent hydrocarbon lines remain live."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `jobType` | string | **Yes** | Work/permit type |
| `location` | string | No | Work location |
| `environment` | string | No | Environmental conditions |
| `equipment` | string[] | No | Equipment list |
| `contractor.name` | string | No | Contractor company |
| `contractor.tier` | 1 \| 2 \| 3 | No | Contractor tier |
| `description` | string | No | Free-text job description (strict keyword check) |

**Example — valid request**

```bash
curl -s -X POST http://localhost:4000/api/v1/tools/hazard-suggest \
  -H "Content-Type: application/json" \
  -d '{
    "jobType": "Hot Work - Welding/Cutting",
    "location": "Bonny Terminal",
    "environment": "Onshore processing area",
    "equipment": ["Welder", "Gas detector"],
    "description": "Flange repair on live crude line"
  }'
```

**Response `200` — valid context**

```json
{
  "success": true,
  "contextValid": true,
  "incorrectKeywords": [],
  "hazardCount": 7,
  "hazards": [
    {
      "name": "Hydrocarbon vapour ignition",
      "category": "chemical",
      "likelihood": 3,
      "severity": 5,
      "recommendedControls": [
        "Continuous gas monitoring",
        "Hot work permit with area isolation",
        "Fire watch throughout operation"
      ],
      "regulatoryRefs": ["DPR EGASPIN Section 5.2.3"],
      "explanation": "Adjacent live crude lines create vapour accumulation risk during welding."
    }
  ],
  "metadata": {
    "regulationsUsed": 3,
    "incidentsUsed": 2,
    "complianceDocsUsed": 1,
    "promptTokens": 1400,
    "completionTokens": 920
  }
}
```

**Example — warn mode (off-topic keywords)**

```bash
curl -s -X POST http://localhost:4000/api/v1/tools/hazard-suggest \
  -H "Content-Type: application/json" \
  -d '{
    "jobType": "Hot Work - Welding/Cutting",
    "equipment": ["Welder"],
    "description": "Flange repair, love rice"
  }'
```

**Response `200` — flagged keywords (still returns hazards)**

```json
{
  "success": true,
  "contextValid": false,
  "incorrectKeywords": [
    {
      "keyword": "love",
      "field": "description",
      "flag": "incorrect_keyword",
      "reason": "Term is not related to permit-to-work, HSE, or oil & gas operations"
    },
    {
      "keyword": "rice",
      "field": "description",
      "flag": "incorrect_keyword",
      "reason": "Term is not related to permit-to-work, HSE, or oil & gas operations"
    }
  ],
  "warnings": [
    "Incorrect keyword(s) detected: \"love\" (description), \"rice\" (description). These terms were excluded from AI analysis. Please remove non-work-related text from the permit."
  ],
  "hazardCount": 6,
  "hazards": [ "..." ],
  "metadata": { "..." }
}
```

| Response field | Description |
|----------------|-------------|
| `contextValid` | `false` when incorrect keywords detected |
| `incorrectKeywords` | Structured flags per term and field |
| `warnings` | UI-friendly warning messages |
| `hazards[].regulatoryRefs` | Optional array of DPR/ISO/IOGP references |
| `metadata.complianceDocsUsed` | Compliance PDF chunks included in prompt |

---

### `POST /api/v1/tools/risk-assess`

Scores hazards using likelihood × severity with rule-based severity floors.

**Request body**

```json
{
  "hazards": [
    {
      "name": "H2S Exposure",
      "category": "chemical",
      "likelihood": 3,
      "severity": 2,
      "recommendedControls": [
        { "name": "Personal H2S monitor", "reductionPercent": 20, "approved": true },
        { "name": "SCBA on standby", "reductionPercent": 25, "approved": true }
      ],
      "regulatoryRefs": ["DPR EGASPIN Section 4.1.2"],
      "explanation": "Sour gas field operations."
    }
  ]
}
```

**Example**

```bash
curl -s -X POST http://localhost:4000/api/v1/tools/risk-assess \
  -H "Content-Type: application/json" \
  -d '{"hazards":[{"name":"H2S Exposure","category":"chemical","likelihood":3,"severity":2,"recommendedControls":[{"name":"H2S monitor","reductionPercent":20,"approved":true},{"name":"SCBA standby","reductionPercent":25,"approved":true}],"explanation":"Sour gas"}]}'
```

**Response `200`**

```json
{
  "success": true,
  "summary": {
    "counts": { "critical": 0, "high": 1, "medium": 0, "low": 0 },
    "totalMatrixSum": 12,
    "averageRiskScore": 12,
    "dominantRiskLevel": "high",
    "rulesApplied": 1,
    "residualCounts": { "critical": 0, "high": 0, "medium": 1, "low": 0 },
    "totalResidualMatrixSum": 6.6,
    "averageResidualRiskScore": 6.6,
    "dominantResidualRiskLevel": "medium",
    "hazardsNeedingAdditionalControls": 0,
    "alarpTargetMaxScore": 9,
    "alarpHazards": 1,
    "intolerableHazards": 0,
    "suggestedControlsInsufficient": 0,
    "overallAdvice": "ALARP — 1 medium residual risk(s) remain within the ALARP range...",
    "confidenceScore": 0.75,
    "confidenceInterval": { "lower": 12, "upper": 12, "level": "95%" }
  },
  "scoredHazards": [
    {
      "hazardName": "H2S Exposure",
      "category": "chemical",
      "likelihood": 3,
      "severity": 4,
      "riskScore": 12,
      "riskLevel": "high",
      "residualRiskScore": 6.6,
      "residualRiskLevel": "medium",
      "projectedResidualRiskScore": 6.6,
      "projectedResidualRiskLevel": "medium",
      "alarpTargetMaxScore": 9,
      "alarpAchieved": true,
      "riskAcceptability": "alarp",
      "suggestedControlsMeetAlarp": true,
      "requiresAdditionalControls": false,
      "additionalReductionNeededPercent": 0,
      "controlEffectiveness": {
        "approvedControlCount": 2,
        "totalReductionPercent": 45,
        "effectiveReductionPercent": 45,
        "suggestedTotalReductionPercent": 45,
        "suggestedEffectiveReductionPercent": 45,
        "maxReductionPercent": 80,
        "capped": false,
        "suggestedCapped": false
      },
      "rationale": "Severity adjusted from 2 to 4 by safety rule constraint.",
      "ruleApplied": true,
      "controls": [
        { "name": "Personal H2S monitor", "reductionPercent": 20, "approved": true },
        { "name": "SCBA on standby", "reductionPercent": 25, "approved": true }
      ]
    }
  ]
}
```

Approved controls reduce the inherent score by their `reductionPercent`; total approved reduction is capped at 80%. Residual risk must be `0-9` to be ALARP. Residual risk `10+` is `intolerable`, returns `requiresAdditionalControls: true`, and means work must not proceed. The `projectedResidualRiskScore` shows whether the full suggested control set would reach ALARP if all controls are approved.

**Risk levels:** ≥15 critical · ≥10 high · ≥5 medium · <5 low

---

### `POST /api/v1/tools/compliance-check`

Validates against DPR EGASPIN, ISO 45001, and IOGP.

**Request body**

```json
{
  "jobContext": {
    "jobType": "Confined Space Entry",
    "location": "Forcados Terminal",
    "environment": "Crude oil storage tank",
    "equipment": ["SCBA", "4-gas monitor"]
  },
  "hazards": [
    {
      "name": "Oxygen-deficient atmosphere",
      "category": "chemical",
      "likelihood": 4,
      "severity": 5,
      "recommendedControls": ["Continuous O2 monitoring", "SCBA"],
      "explanation": "Nitrogen purging displaces oxygen."
    }
  ]
}
```

**Response `200`**

```json
{
  "success": true,
  "overallCompliant": false,
  "standards": [
    {
      "standard": "DPR EGASPIN",
      "compliant": true,
      "findings": [],
      "recommendations": []
    },
    {
      "standard": "ISO 45001",
      "compliant": false,
      "findings": ["No documented rescue drill within 6 months"],
      "recommendations": ["Conduct confined space rescue drill before entry"]
    },
    {
      "standard": "IOGP",
      "compliant": true,
      "findings": [],
      "recommendations": []
    }
  ],
  "metadata": { "promptTokens": 980, "completionTokens": 640 }
}
```

---

### `POST /api/v1/tools/permit-validate`

Four-layer validation: rule-based → semantic AI → compliance → anomaly.

**Request body** — same shape as `compliance-check`.

**Response `200`**

```json
{
  "success": true,
  "recommendation": "Flag for Review",
  "allPassed": false,
  "totalIssues": 2,
  "layers": [
    { "layer": "rule_based", "passed": true, "issueCount": 0, "issues": [], "confidence": 1.0 },
    { "layer": "semantic", "passed": false, "issueCount": 1, "issues": ["..."], "confidence": 0.85 },
    { "layer": "compliance", "passed": false, "issueCount": 1, "issues": ["..."], "confidence": 0.9 },
    { "layer": "anomaly", "passed": true, "issueCount": 0, "issues": [], "confidence": 0.9 }
  ]
}
```

---

### `POST /api/v1/tools/anomaly-detect`

Deterministic copy-paste / pattern detection. No AI calls.

**Request body**

```json
{
  "hazards": [
    {
      "name": "Generic hazard 1",
      "category": "physical",
      "likelihood": 2,
      "severity": 2,
      "recommendedControls": ["Wear PPE"],
      "explanation": "Standard risk."
    }
  ]
}
```

**Response `200`**

```json
{
  "success": true,
  "anomaliesDetected": false,
  "issueCount": 0,
  "issues": [],
  "confidence": 0.9
}
```

---

### `POST /api/v1/tools/simops-check`

Schedule conflicts and incompatible work-type pairs.

**Request body**

```json
{
  "request": {
    "startDate": "2026-06-01",
    "endDate": "2026-06-07",
    "workType": "Hot Work - Welding/Cutting",
    "workArea": "Process Area A"
  },
  "permits": [
    {
      "id": 110,
      "status": "active",
      "workType": "Confined Space Entry",
      "workArea": "Process Area A",
      "startDate": "2026-06-03T07:00:00.000Z",
      "endDate": "2026-06-05T16:00:00.000Z"
    }
  ]
}
```

**Response `200`**

```json
{
  "success": true,
  "request": { "..." },
  "conflicts": { "count": 0, "permits": [] },
  "simopsFlags": {
    "count": 1,
    "flags": [
      {
        "permitId": 110,
        "requestWorkType": "Hot Work - Welding/Cutting",
        "conflictingWorkType": "Confined Space Entry",
        "severity": "critical",
        "reason": "Hot Work must not be performed simultaneously with Confined Space Entry."
      }
    ]
  },
  "overallRisk": "critical",
  "summary": "1 SIMOPS incompatibility flag(s) (1 critical). Overall risk: CRITICAL."
}
```

---

## Agent workflows

Base path: `/api/v1/agent`

---

### `GET /api/v1/agent/tools`

Lists all tools and workflows with schemas. No body.

```bash
curl -s http://localhost:4000/api/v1/agent/tools
```

---

### `POST /api/v1/agent/full-assessment`

Pipeline: hazard-suggest → risk-assess → compliance-check + permit-validate (parallel).

**Headers**

```http
Content-Type: application/json
```

**Request body** — `JobContext` (same as hazard-suggest).

**Response `200`** (abbreviated)

```json
{
  "success": true,
  "jobContext": { "..." },
  "contextValid": true,
  "incorrectKeywords": [],
  "warnings": null,
  "recommendation": "Flag for Review",
  "steps": {
    "hazardSuggest": {
      "contextValid": true,
      "incorrectKeywords": [],
      "warnings": null,
      "hazardCount": 8,
      "hazards": [ "..." ],
      "metadata": {
        "regulationsUsed": 4,
        "incidentsUsed": 2,
        "complianceDocsUsed": 1,
        "promptTokens": 1400,
        "completionTokens": 920
      }
    },
    "riskAssess": { "summary": { "..." }, "scoredHazards": [ "..." ] },
    "complianceCheck": { "overallCompliant": false, "standards": [ "..." ] },
    "permitValidate": { "allPassed": false, "totalIssues": 2, "layers": [ "..." ] }
  }
}
```

Typical latency: **15–30 seconds**.

---

### `POST /api/v1/agent/quick-assess`

Pipeline: hazard-suggest → risk-assess.

**Request body** — `JobContext`.

**Response `200`** includes `contextValid`, `incorrectKeywords`, `warnings`, `requiresFullAssessment`, `riskSummary`, `hazards`, `scoredHazards`.

Typical latency: **8–12 seconds**.

---

### `POST /api/v1/agent/simops-assess`

Pipeline: SIMOPS_CHECK → hazard-suggest (parallel) → risk-assess → AI briefing.

**Request body**

```json
{
  "request": {
    "startDate": "2026-06-01",
    "endDate": "2026-06-07",
    "workType": "Hot Work - Welding/Cutting",
    "workArea": "Process Area A"
  },
  "permits": [ { "id": 110, "status": "active", "workType": "Confined Space Entry", "workArea": "Process Area A", "startDate": "...", "endDate": "..." } ],
  "jobContext": {
    "location": "Bonny Terminal",
    "environment": "Offshore platform",
    "description": "Pipe flange welding"
  }
}
```

**Response `200`** includes `contextValid`, `incorrectKeywords`, `warnings`, `recommendation` (`HOLD` | `PROCEED WITH CONTROLS` | `SAFE TO PROCEED`), `steps.simopsCheck`, `steps.safetyBriefing`.

---

## Routing (Feature 1)

Base path: `/api/v1/agent/routing`

ePTW frontend aliases (no `v1`):

- `POST /api/agent/permits/:id/pre-submission-check`
- `POST /api/agent/permits/:id/recommend-routing`

---

### `POST /api/v1/agent/routing/recommend`

Recommends approvers, missing controls, SIMOPS overlaps.

**Request body**

```json
{
  "permit": {
    "id": 42,
    "type": "Hot Work Permit",
    "workType": "Hot Work - Welding/Cutting",
    "workArea": "Process Unit 3",
    "severity": "High",
    "likelihood": "Likely",
    "hazards": ["Fire/explosion", "Burns"],
    "controlMeasures": ["Gas test", "Fire watch"],
    "isolationSections": [],
    "startDate": "2026-06-10",
    "endDate": "2026-06-10"
  },
  "availableUsers": [
    { "userId": 1, "name": "Jane HSE", "role": "HSE Manager", "currentQueue": 2 },
    { "userId": 2, "name": "John Gas", "role": "Gas Tester", "currentQueue": 0 }
  ],
  "activePermits": [],
  "riskOptions": {}
}
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "recommendedApprovers": [
      { "userId": 2, "name": "John Gas", "role": "Gas Tester", "currentQueue": 0 }
    ],
    "routingPath": ["HSE Manager", "Gas Tester"],
    "missingControls": ["Fire watch not listed"],
    "isolationIssues": [],
    "routingNotes": "Hot work near live lines requires gas tester sign-off.",
    "riskRating": "HIGH",
    "simopsConflicts": [],
    "confidence": 0.85
  },
  "metadata": {
    "promptTokens": 820,
    "completionTokens": 210
  }
}
```

---

### `POST /api/v1/agent/routing/pre-submission-check`

Pre-submission completeness check before permit is submitted.

**Request body**

```json
{
  "permit": {
    "workType": "Confined Space Entry",
    "workArea": "Tank T-101",
    "hazards": [],
    "controlMeasures": [],
    "attachments": []
  },
  "riskOptions": {}
}
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "ready": false,
    "issues": [
      { "field": "hazards", "message": "At least one hazard must be identified before submission" },
      { "field": "controlMeasures", "message": "Control measures are required" }
    ],
    "suggestions": ["Run a hazard assessment for your work type"]
  },
  "metadata": {
    "promptTokens": 650,
    "completionTokens": 180
  }
}
```

---

## Fraud (Feature 2)

Base path: `/api/v1/agent/fraud`

---

### `POST /api/v1/agent/fraud/permit-check`

Single-permit fraud and consistency checks.

**Request body**

```json
{
  "permit": {
    "id": 42,
    "issuerId": 10,
    "approverId": 11,
    "status": "approved",
    "workType": "Hot Work",
    "workArea": "Unit 3",
    "created_at": "2026-06-01T08:00:00.000Z",
    "signatures": [
      { "userId": 10, "role": "Issuer", "signedAt": "2026-06-01T08:05:00.000Z", "ipAddress": "10.0.0.1" }
    ],
    "isolationSections": []
  },
  "auditLogs": [
    { "action": "create_and_submit_permit", "userId": 10, "permitId": 42, "created_at": "2026-06-01T08:00:00.000Z" }
  ],
  "userRoles": { "10": "Permit Issuer", "11": "HSE Manager" },
  "similarPermits": []
}
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "permitId": 42,
    "flagged": false,
    "severity": "NONE",
    "riskScore": 0.05,
    "summary": "No significant anomalies detected.",
    "anomalies": []
  },
  "metadata": {
    "promptTokens": 540,
    "completionTokens": 120
  }
}
```

---

### `POST /api/v1/agent/fraud/user-anomaly`

Detects unusual user behaviour from audit logs.

**Request body**

```json
{
  "userId": 10,
  "auditLogs": [
    { "action": "approve_permit", "userId": 10, "permitId": 1, "created_at": "2026-06-01T09:00:00.000Z" }
  ],
  "permits": []
}
```

---

### `POST /api/v1/agent/fraud/scan`

Batch scan of multiple permits.

**Request body**

```json
{
  "permits": [ { "id": 1, "issuerId": 10, "approverId": 10, "status": "approved" } ],
  "auditLogs": [],
  "userRoles": {}
}
```

---

## Analytics (Feature 3)

Base path: `/api/v1/agent/analytics`

---

### `POST /api/v1/agent/analytics/trends`

Permit volume, hazard frequencies, risk trends.

**Request body**

```json
{
  "permits": [
    {
      "id": 1,
      "workType": "Hot Work - Welding/Cutting",
      "workArea": "Unit 3",
      "status": "approved",
      "severity": "High",
      "likelihood": "Likely",
      "created_at": "2026-05-01T08:00:00.000Z"
    }
  ],
  "auditLogs": [],
  "facilityId": 1,
  "from": "2026-01-01",
  "to": "2026-06-01"
}
```

**Response `200`**

```json
{
  "success": true,
  "volumeByMonth": [ { "month": "2026-05", "total": 12, "approved": 10, "rejected": 1, "suspended": 1 } ],
  "workTypeDistribution": [ { "workType": "Hot Work - Welding/Cutting", "count": 5, "percentage": 41.7 } ],
  "hazardFrequency": [ { "hazard": "Fire/explosion", "count": 8 } ],
  "aiInsights": { "riskTrends": "...", "recommendations": ["..."] }
}
```

---

### `POST /api/v1/agent/analytics/predictions`

Predictive risk modelling from historical permits.

**Request body**

```json
{
  "permits": [ "..." ],
  "horizonDays": 30
}
```

---

### `POST /api/v1/agent/analytics/incident-correlation`

Correlates permit patterns with incident risk.

**Request body**

```json
{
  "permits": [ "..." ],
  "incidents": [
    { "date": "2026-03-01", "workType": "Hot Work", "outcome": "high", "description": "Flash fire during welding" }
  ]
}
```

---

### `POST /api/v1/agent/analytics/compliance-report`

Compliance posture report across permits.

**Request body**

```json
{
  "permits": [ "..." ],
  "from": "2026-01-01",
  "to": "2026-06-01"
}
```

---

## Data schemas

### JobContext

```typescript
{
  jobType: string                 // required
  location?: string
  environment?: string
  equipment?: string[]
  contractor?: { name: string; tier: 1 | 2 | 3 }
  description?: string            // strict keyword validation
}
```

### Hazard

```typescript
{
  name: string
  category: "chemical" | "physical" | "biological" | "ergonomic"
  likelihood: 1 | 2 | 3 | 4 | 5
  severity: 1 | 2 | 3 | 4 | 5
  recommendedControls: Array<string | {
    name: string
    reductionPercent: number
    approved?: boolean
  }>
  regulatoryRefs?: string[]       // DPR EGASPIN, ISO 45001, IOGP
  explanation: string
}
```

### IncorrectKeyword

```typescript
{
  keyword: string
  field: string                   // e.g. "description", "equipment[0]"
  flag: "incorrect_keyword"
  reason: string
}
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `4000` | REST API port |
| `GOOGLE_API_KEY` | — | Gemini API key (required) |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Chat model |
| `QDRANT_HOST` | `http://localhost:6333` | Qdrant URL |
| `QDRANT_KEY` | — | Qdrant API key (cloud) |
| `HAZARD_CONFIDENCE_THRESHOLD` | `0.7` | Min RAG similarity score |
| `MAX_HAZARD_SUGGESTIONS` | `10` | Max hazards per suggestion |
| `AI_TEMPERATURE` | `0` | LLM temperature |

---

## Quick reference — all endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Health check |
| POST | `/api/v1/tools/hazard-suggest` | AI hazard suggestion |
| POST | `/api/v1/tools/risk-assess` | Risk matrix scoring |
| POST | `/api/v1/tools/compliance-check` | Regulatory compliance |
| POST | `/api/v1/tools/permit-validate` | 4-layer validation |
| POST | `/api/v1/tools/anomaly-detect` | Copy-paste detection |
| POST | `/api/v1/tools/simops-check` | SIMOPS conflicts |
| GET | `/api/v1/agent/tools` | List tools/workflows |
| POST | `/api/v1/agent/full-assessment` | Full permit pipeline |
| POST | `/api/v1/agent/quick-assess` | Fast 2-step assess |
| POST | `/api/v1/agent/simops-assess` | SIMOPS workflow |
| POST | `/api/v1/agent/routing/recommend` | Approver routing |
| POST | `/api/v1/agent/routing/pre-submission-check` | Pre-submit check |
| POST | `/api/v1/agent/fraud/permit-check` | Permit fraud check |
| POST | `/api/v1/agent/fraud/user-anomaly` | User behaviour anomaly |
| POST | `/api/v1/agent/fraud/scan` | Batch fraud scan |
| POST | `/api/v1/agent/analytics/trends` | Trend analytics |
| POST | `/api/v1/agent/analytics/predictions` | Predictive risk |
| POST | `/api/v1/agent/analytics/incident-correlation` | Incident correlation |
| POST | `/api/v1/agent/analytics/compliance-report` | Compliance report |

---

## MCP server

The MCP server runs separately on port **3000** (`pnpm start:http`). Tool names and parameters mirror the REST tools. See [mcp.md](./mcp.md).
