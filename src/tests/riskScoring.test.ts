/**
 * Unit tests for RiskScoringService.
 * Run: npx tsx src/tests/riskScoring.test.ts
 */
import { RiskScoringService } from "../services/riskScoringService.js";
import type { Hazard } from "../schemas/index.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

console.log("\n── RiskScoringService tests ──\n");

// Approved controls reduce the inherent score, but high residual risk still blocks.
{
  const service = new RiskScoringService();
  const hazards: Hazard[] = [
    {
      name: "Explosion during hot work",
      category: "physical",
      likelihood: 4,
      severity: 5,
      recommendedControls: [
        { name: "Gas test", reductionPercent: 25, approved: true },
        { name: "Fire watch", reductionPercent: 20, approved: true },
      ],
      explanation: "Hot work near hydrocarbons creates ignition risk.",
    },
  ];

  const [scored] = service.scoreHazards(hazards);
  const summary = service.computeSummary([scored]);

  assert(scored.riskScore.risk === 20, "keeps inherent risk score before controls");
  assert(scored.controlEffectiveness.effectiveReductionPercent === 45, "sums approved control percentages");
  assert(scored.residualRiskScore === 11, "reduces score by approved control percentage");
  assert(scored.residualRiskLevel === "high", "residual score can remain high after approval");
  assert(scored.alarpAchieved === false, "marks residual score above 9 as not ALARP");
  assert(scored.riskAcceptability === "intolerable", "classifies residual score above 9 as intolerable");
  assert(scored.suggestedControlsMeetAlarp === false, "detects insufficient suggested controls");
  assert(scored.additionalReductionNeededPercent === 10, "calculates extra approved reduction needed for ALARP");
  assert(scored.requiresAdditionalControls === true, "flags intolerable residual risk for more controls");
  assert(summary.residualCounts.high === 1, "summary counts high residual risk");
  assert(summary.intolerableHazards === 1, "summary counts intolerable hazards");
  assert(summary.suggestedControlsInsufficient === 1, "summary detects controls that cannot reach ALARP");
  assert(
    summary.overallAdvice.includes("NO WORK"),
    "summary blocks work when residual risk exceeds ALARP"
  );
}

// Excessive approved controls are capped so a serious hazard cannot be reduced to zero.
{
  const service = new RiskScoringService();
  const hazards: Hazard[] = [
    {
      name: "H2S exposure",
      category: "chemical",
      likelihood: 5,
      severity: 4,
      recommendedControls: [
        { name: "Gas monitor", reductionPercent: 40, approved: true },
        { name: "SCBA", reductionPercent: 35, approved: true },
        { name: "Rescue team", reductionPercent: 30, approved: true },
      ],
      explanation: "Sour gas environment.",
    },
  ];

  const [scored] = service.scoreHazards(hazards);

  assert(scored.controlEffectiveness.totalReductionPercent === 105, "records total approved percentage");
  assert(scored.controlEffectiveness.effectiveReductionPercent === 80, "caps effective reduction");
  assert(scored.controlEffectiveness.suggestedEffectiveReductionPercent === 80, "caps suggested reduction");
  assert(scored.controlEffectiveness.capped === true, "marks capped reductions");
  assert(scored.controlEffectiveness.suggestedCapped === true, "marks suggested capped reductions");
  assert(scored.residualRiskScore === 4, "applies capped reduction to residual score");
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);

if (failed > 0) {
  process.exit(1);
}
