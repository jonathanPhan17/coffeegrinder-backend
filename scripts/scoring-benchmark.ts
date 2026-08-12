// Opt-in scoring-model benchmark. PAID — every posting scored is a real Bedrock call
// (roughly $0.02–0.05 each on Sonnet-class models), so this is NOT part of `npm test` or CI.
// Run it only when deciding whether a candidate model may take over match scoring.
//
// What it does: pulls real (criteria, résumé) pairs already stored in DynamoDB — postings
// from past runs plus the parsed résumé — and pushes each through the SHIPPED scoreMatch
// path (forced tool-use, Zod validation, self-correcting retries, cache prefix) against
// whatever BEDROCK_MODEL_ID is set. Quality is judged by the same deterministic verifier
// production uses (verifyEvidence): the fabricated-quote fraction, plus retry counts, token
// usage, wall time, and an estimated dollar cost. Results land in a JSON file; run once per
// model, then `--compare a.json b.json` prints the side-by-side.
//
// Postings are scored sequentially, matching a steady-state run: call 1 cache-WRITES the
// résumé prefix (cold), later calls cache-read it.
//
// Usage (PowerShell) — keep --out names matching scoring-benchmark-*.json, the .gitignore
// pattern that keeps result files (local evidence) out of the repo:
//   $env:TABLE_NAME="<table>"; $env:BEDROCK_MODEL_ID="us.anthropic.claude-sonnet-4-5-20250929-v1:0"
//   npx ts-node scripts/scoring-benchmark.ts --out scoring-benchmark-sonnet.json
//   $env:BEDROCK_MODEL_ID="us.anthropic.claude-haiku-4-5-20251001-v1:0"
//   npx ts-node scripts/scoring-benchmark.ts --out scoring-benchmark-haiku.json
//   npx ts-node scripts/scoring-benchmark.ts --compare scoring-benchmark-sonnet.json scoring-benchmark-haiku.json
// Usage (bash): same flags; TABLE_NAME=<table> BEDROCK_MODEL_ID=<id> npx ts-node …
// The table name comes from `aws dynamodb list-tables` (the Coffeegrinder-Data one).
// Flags: --limit N (default 12 postings), --out FILE, --user ID (default 'me').

import { readFileSync, writeFileSync } from 'node:fs';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { PostingCriteriaSchema } from '../src/ai/posting-criteria';
import { scoreMatch } from '../src/ai/score-match';
import { getResumeText } from '../src/data/resume-profile';
import { verifyEvidence } from '../src/matching/verify';
import { ddb } from '../src/shared/dynamodb';
import { TABLE_NAME } from '../src/shared/env';
import { logger } from '../src/shared/logger';

interface Args {
  limit: number;
  out: string;
  user: string;
  compare: [string, string] | null;
}

// Items were written by our own workers, but Zod stays the trust boundary on the way back
// out of the table too — a drifted or hand-edited item is skipped, not crashed on.
const PostingItemSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  sourceId: z.string().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  criteria: PostingCriteriaSchema,
});

interface BenchPosting {
  runId: string;
  sourceId: string;
  title: string;
  criteria: z.infer<typeof PostingCriteriaSchema>;
}

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

interface VerdictCounts {
  met: number;
  partial: number;
  notMet: number;
}

interface PostingMetric {
  runId: string;
  sourceId: string;
  title: string;
  criteriaCount: number;
  scored: boolean;
  fabricatedFraction: number | null;
  /** Post-verify distribution — fabricated quotes already downgraded to not_met. */
  verdicts: VerdictCounts | null;
  retries: number;
  exhausted: boolean;
  wallMs: number;
  tokens: TokenTotals;
}

interface BenchmarkResult {
  modelId: string;
  generatedAt: string;
  user: string;
  resumeChars: number;
  postings: PostingMetric[];
  aggregate: {
    postings: number;
    scored: number;
    meanFabricatedFraction: number | null;
    maxFabricatedFraction: number | null;
    /**
     * Summed post-verify verdicts. The check fabricatedFraction cannot make: that metric is
     * one-sided (only met/partial verdicts carry quotes), so a model could ace it by calling
     * everything not_met — a verdict-mix shift between models exposes exactly that collapse.
     */
    verdictTotals: VerdictCounts;
    totalRetries: number;
    exhaustedCount: number;
    meanWallMs: number;
    tokens: TokenTotals;
    estUsd: number | null;
  };
}

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// USD per million tokens, us-west-1 list prices as of 2026-08 — keyed by foundation-model id
// (geo prefixes stripped before lookup). Add a row when benchmarking a new model; an unknown
// id still reports tokens, just no dollar estimate. Sonnet 5's intro pricing ($2/$10) ends
// 2026-08-31 — if you add it, use the post-promo rate so the comparison stays durable.
const PRICES: Record<string, Price> = {
  'anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

function priceFor(modelId: string): Price | null {
  return PRICES[modelId.replace(/^(us|eu|apac)\./, '')] ?? null;
}

function parseArgs(argv: string[]): Args {
  // 'me' is the pre-Cognito single-user id every historical run/profile was stored
  // under — the data this benchmark reads. Post-auth data needs --user <sub>.
  const args: Args = { limit: 12, out: '', user: 'me', compare: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--limit') args.limit = Number(argv[++i]);
    else if (flag === '--out') args.out = argv[++i];
    else if (flag === '--user') args.user = argv[++i];
    else if (flag === '--compare') args.compare = [argv[++i], argv[++i]];
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!args.compare && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  return args;
}

// Retries and token usage are only visible through callTool's structured logs, so capture
// them in-process: wrap the logger, keep forwarding so a paid run still narrates itself.
interface CapturedLog {
  level: 'info' | 'warn';
  attrs: Record<string, unknown>;
}
const captured: CapturedLog[] = [];

function captureLogger(): void {
  for (const level of ['info', 'warn'] as const) {
    const original = logger[level].bind(logger);
    // Typed to the (message, attributes) shape every callTool log uses — narrower than the
    // full powertools overload set, hence the assertion on assignment.
    logger[level] = ((message: string, attrs?: Record<string, unknown>): void => {
      if (attrs) {
        captured.push({ level, attrs });
        original(message, attrs);
      } else {
        original(message);
      }
    }) as typeof logger.info;
  }
}

function sumTokens(events: CapturedLog[]): TokenTotals {
  const totals: TokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  for (const event of events) {
    const usage = event.attrs.usage as Partial<TokenTotals> | undefined;
    if (!usage) continue;
    totals.inputTokens += usage.inputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    totals.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    totals.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0;
  }
  return totals;
}

function estimateUsd(tokens: TokenTotals, modelId: string): number | null {
  const price = priceFor(modelId);
  if (!price) return null;
  return (
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadInputTokens * price.cacheRead +
      tokens.cacheWriteInputTokens * price.cacheWrite) /
    1_000_000
  );
}

async function loadPostings(limit: number): Promise<BenchPosting[]> {
  const found: BenchPosting[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let startKey: Record<string, unknown> | undefined;
  // The single table is tiny (tens of items) — one filtered Scan is the honest access
  // pattern here, and this script is read-only against it.
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(SK, :posting) AND attribute_exists(criteria)',
        ExpressionAttributeValues: { ':posting': 'POSTING#' },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const raw of page.Items ?? []) {
      const parsed = PostingItemSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const item = parsed.data;
      const sourceId = item.sourceId ?? item.SK.slice('POSTING#'.length);
      // The same posting fetched in two runs shares its sourceId — score it once, or
      // duplicates skew every aggregate toward whatever that posting's JD looks like.
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      found.push({
        runId: item.PK.slice('RUN#'.length),
        sourceId,
        title: [item.title, item.company].filter(Boolean).join(' @ ') || sourceId,
        criteria: item.criteria,
      });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  if (skipped > 0) console.log(`[benchmark] skipped ${skipped} malformed posting item(s)`);
  // Scan order follows partition-key hash and shifts whenever a run adds postings — sort so
  // two benchmark invocations score the same set (compare() still warns if the table
  // changed in between).
  found.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  if (found.length > limit) {
    console.log(`[benchmark] ${found.length} unique postings available, using first ${limit}`);
  }
  return found.slice(0, limit);
}

async function runBenchmark(args: Args): Promise<void> {
  const modelId = process.env.BEDROCK_MODEL_ID ?? '';
  if (!TABLE_NAME || !modelId) {
    throw new Error('set TABLE_NAME and BEDROCK_MODEL_ID before running the benchmark');
  }
  const resumeText = await getResumeText(args.user);
  if (!resumeText) throw new Error(`no parsed résumé stored for user '${args.user}'`);
  const postings = await loadPostings(args.limit);
  if (postings.length === 0) throw new Error('no postings with criteria found in the table');

  console.log(`[benchmark] model=${modelId}`);
  console.log(
    `[benchmark] ${postings.length} postings × 1 scoring call — PAID Bedrock usage starts now\n`,
  );
  captureLogger();

  const metrics: PostingMetric[] = [];
  for (const posting of postings) {
    const before = captured.length;
    const t0 = Date.now();
    let fabricatedFraction: number | null = null;
    let verdicts: VerdictCounts | null = null;
    let scored = false;
    try {
      const result = await scoreMatch(resumeText, posting.criteria);
      const checked = verifyEvidence(result.criteria, resumeText);
      fabricatedFraction = checked.fabricatedFraction;
      verdicts = { met: 0, partial: 0, notMet: 0 };
      for (const c of checked.verified) {
        if (c.verdict === 'met') verdicts.met += 1;
        else if (c.verdict === 'partial') verdicts.partial += 1;
        else verdicts.notMet += 1;
      }
      scored = true;
    } catch (err) {
      console.error(`[benchmark] ${posting.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const events = captured.slice(before);
    const metric: PostingMetric = {
      runId: posting.runId,
      sourceId: posting.sourceId,
      title: posting.title,
      criteriaCount:
        posting.criteria.must_haves.length +
        posting.criteria.nice_to_haves.length +
        posting.criteria.dealbreakers.length,
      scored,
      fabricatedFraction,
      verdicts,
      retries: events.filter((e) => e.attrs.event === 'llm_validation_retry').length,
      exhausted: events.some((e) => e.attrs.event === 'llm_validation_exhausted'),
      wallMs: Date.now() - t0,
      tokens: sumTokens(events),
    };
    metrics.push(metric);
    console.log(
      `[benchmark] ${posting.title}: fabricated=${fabricatedFraction === null ? 'n/a' : fabricatedFraction.toFixed(2)} verdicts=${verdicts ? `${verdicts.met}met/${verdicts.partial}partial/${verdicts.notMet}not` : 'n/a'} retries=${metric.retries} ${metric.wallMs}ms`,
    );
  }

  const fabricated = metrics
    .map((m) => m.fabricatedFraction)
    .filter((f): f is number => f !== null);
  const tokens = sumTokens(captured);
  const result: BenchmarkResult = {
    modelId,
    generatedAt: new Date().toISOString(),
    user: args.user,
    resumeChars: resumeText.length,
    postings: metrics,
    aggregate: {
      postings: metrics.length,
      scored: metrics.filter((m) => m.scored).length,
      meanFabricatedFraction: fabricated.length
        ? fabricated.reduce((a, b) => a + b, 0) / fabricated.length
        : null,
      maxFabricatedFraction: fabricated.length ? Math.max(...fabricated) : null,
      verdictTotals: metrics.reduce<VerdictCounts>(
        (acc, m) =>
          m.verdicts
            ? {
                met: acc.met + m.verdicts.met,
                partial: acc.partial + m.verdicts.partial,
                notMet: acc.notMet + m.verdicts.notMet,
              }
            : acc,
        { met: 0, partial: 0, notMet: 0 },
      ),
      totalRetries: metrics.reduce((a, m) => a + m.retries, 0),
      exhaustedCount: metrics.filter((m) => m.exhausted).length,
      meanWallMs: Math.round(metrics.reduce((a, m) => a + m.wallMs, 0) / metrics.length),
      tokens,
      estUsd: estimateUsd(tokens, modelId),
    },
  };

  const out = args.out || `scoring-benchmark-${modelId.replace(/[^a-z0-9]+/gi, '-')}.json`;
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\n[benchmark] wrote ${out}`);
  printAggregate(result);
}

function printAggregate(result: BenchmarkResult): void {
  const a = result.aggregate;
  console.log(`  model:               ${result.modelId}`);
  console.log(`  postings scored:     ${a.scored}/${a.postings}`);
  console.log(
    `  fabricated quotes:   mean ${fmt(a.meanFabricatedFraction)} · max ${fmt(a.maxFabricatedFraction)}`,
  );
  console.log(
    `  verdicts (verified): met ${a.verdictTotals.met} · partial ${a.verdictTotals.partial} · not_met ${a.verdictTotals.notMet}`,
  );
  console.log(`  validation retries:  ${a.totalRetries} (exhausted: ${a.exhaustedCount})`);
  console.log(`  mean wall time:      ${a.meanWallMs}ms`);
  console.log(
    `  tokens:              in ${a.tokens.inputTokens} · out ${a.tokens.outputTokens} · cacheRead ${a.tokens.cacheReadInputTokens} · cacheWrite ${a.tokens.cacheWriteInputTokens}`,
  );
  console.log(`  est. cost:           ${a.estUsd === null ? 'unknown model — add it to PRICES' : `$${a.estUsd.toFixed(4)}`}`);
}

function fmt(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

function compare(files: [string, string]): void {
  const [a, b] = files.map(
    (file) => JSON.parse(readFileSync(file, 'utf8')) as BenchmarkResult,
  );
  // Aggregates only compare cleanly over the same postings; runs added to the table between
  // benchmark invocations shift the scored set, and a delta then reflects posting drift.
  const idsA = new Set(a.postings.map((p) => p.sourceId));
  const idsB = new Set(b.postings.map((p) => p.sourceId));
  const onlyA = [...idsA].filter((id) => !idsB.has(id)).length;
  const onlyB = [...idsB].filter((id) => !idsA.has(id)).length;
  if (onlyA || onlyB) {
    console.log(
      `[benchmark] WARNING: different posting sets (${onlyA} only in ${files[0]}, ${onlyB} only in ${files[1]}) — aggregate deltas partly reflect posting drift, not model quality. Re-run both against the current table.\n`,
    );
  }
  console.log('[benchmark] baseline vs candidate\n');
  printAggregate(a);
  console.log('');
  printAggregate(b);
  console.log(
    '\nReading it: fabricated-quote rate is one-sided — a model can ace it by calling',
    'everything not_met, so check the verdict mix first: a big shift toward not_met on the',
    'same postings is a quality collapse, not a win. The candidate holds up if the verdict',
    'mix is stable, mean fabricated stays within ~0.05 of the baseline (production tolerates',
    'up to 1/3 per posting before re-scoring), and no validation exhaustions appear — then',
    'cost and wall time decide. The decision stays human; this prints evidence, not verdicts.',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.compare) {
    compare(args.compare);
    return;
  }
  await runBenchmark(args);
}

void main().catch((err: unknown) => {
  console.error(`[benchmark] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
