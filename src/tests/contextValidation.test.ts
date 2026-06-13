/**
 * Unit tests for ContextValidationService.
 * Run: npx tsx src/tests/contextValidation.test.ts
 */
import { validateJobContext, extractRelevanceTerms } from "../services/contextValidationService.js";

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

console.log("\n── ContextValidationService tests ──\n");

// 1. Flags blocklisted words in description
{
  const r = validateJobContext({
    jobType: "Hot Work - Welding/Cutting",
    location: "Bonny Terminal, Rivers State",
    description: "Repair flange near unit 3, love rice dinner",
    equipment: ["Welding set"],
  });

  assert(r.contextValid === false, "invalid when love/rice in description");
  assert(
    r.incorrectKeywords.some((k) => k.keyword === "love" && k.field === "description"),
    "flags love in description"
  );
  assert(
    r.incorrectKeywords.some((k) => k.keyword === "rice" && k.field === "description"),
    "flags rice in description"
  );
  assert(
    r.sanitizedContext.description === "Repair flange near unit 3,",
    "strips love, rice, and blocklisted dinner from description"
  );
}

// 2. Location names are NOT flagged as unknown
{
  const r = validateJobContext({
    jobType: "Hot Work",
    location: "Bonny Terminal, Warri, OML 40",
    environment: "Offshore platform Niger Delta",
    equipment: ["Welder"],
    description: "Pipeline flange repair",
  });

  assert(r.contextValid === true, "valid context with geographic location names");
  assert(r.incorrectKeywords.length === 0, "no false positives on location/environment");
}

// 3. Blocklist still applies to location
{
  const r = validateJobContext({
    jobType: "Hot Work",
    location: "Platform A love zone",
    equipment: ["Welder"],
  });

  assert(r.contextValid === false, "flags blocklist in location");
  assert(
    r.incorrectKeywords.some((k) => k.keyword === "love"),
    "love flagged even in location field"
  );
}

// 4. Valid HSE description passes
{
  const r = validateJobContext({
    jobType: "Confined Space Entry",
    location: "Tank T-101",
    environment: "Sour gas field offshore",
    equipment: ["4-gas monitor", "SCBA", "Tripod"],
    description: "Internal inspection after nitrogen purge and gas test",
  });

  assert(r.contextValid === true, "valid HSE description passes strict check");
}

// 5. Equipment names not rejected as unknown
{
  const r = validateJobContext({
    jobType: "Hot Work - Welding/Cutting",
    equipment: ["Angle grinder", "MIG welder", "XR-500 gas detector"],
    description: "Welding on pipe rack",
  });

  assert(r.contextValid === true, "equipment model names not flagged");
}

// 6. extractRelevanceTerms includes job type tokens
{
  const terms = extractRelevanceTerms({
    jobType: "Hot Work - Welding/Cutting",
    description: "Flange repair",
  });

  assert(terms.has("hot") || terms.has("work"), "relevance terms include job type words");
  assert(terms.has("flange") || terms.has("repair"), "relevance terms include description");
}

// 7. Contractor name is not validated (skipped in validateJobContext)
{
  const r = validateJobContext({
    jobType: "Hot Work",
    contractor: { name: "Love Rice Catering Ltd", tier: 2 },
    equipment: ["Welder"],
    description: "Welding repair",
  });

  assert(r.contextValid === true, "contractor name not scanned for keywords");
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);

if (failed > 0) {
  process.exit(1);
}
