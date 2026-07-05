# Backlog

Deferred items surfaced during implementation. Remove an entry once it's resolved —
this file should only ever reflect what's still outstanding.

## Mock → live cutover (paste flow)

The frontend is still MOCK-backed (`endpoints.ts` `MOCK = true`). The backend already
satisfies the run/matches contract, so the cutover is gated only on a **postings source** —
NOT on Apify specifically. Shape of the cutover slice: build out the existing disabled
"Paste · soon" control (`RunSetupForm.tsx`, `RunSource = 'auto' | 'paste'`) into a real paste
tab that sends `postings[]` on `POST /runs`, then flip the run/matches endpoints
(`startRun`/`getRun`/`listMatches`/`getMatch`) to the live client **per-endpoint**, leaving
cover letters mocked (no §9.8 backend yet). That puts real end-to-end product use one small
slice away; Apify (the `auto` source) is a later, independent source behind the same
`JobSource` seam.

## parseFailed handling

`ParseResume` worker throws on parse failure but there's no `parseFailed` state
surfaced to the frontend. Needs a coordinated `domain.ts` change (frontend has no
field for it yet) before this can be picked up.

## Resume-structure prompt polish

Both are prompt tweaks in `src/ai/resume-structure.ts`; low priority. Worth waiting to
see how the matching scorecard actually consumes these fields before tuning.

- **Skills near-duplicates.** A real parse returned both `React` and `ReactJS` (also
  variant/abbreviation pairs generally). The tool schema says "deduplicated" but the
  model splits synonyms — tighten the `skills` description to "merge synonymous skills;
  don't list both a technology and its abbreviation/variant."
- **Third-person `experience`.** Output is written in third person using the
  candidate's name ("Max is a full-stack developer…"). If the UI renders it as the
  candidate's own summary, switch the prompt to first-person or name-agnostic phrasing.

## POST /runs — orphaned run if kickoff fails

In `src/routes/runs.ts`, if `startRunExecution` throws after `putRun` succeeds, the run
row is left in `queued` and the client gets a 500 — the frontend would poll it forever.
Fix: wrap the kickoff and set the stored run to `status: 'error'` before rethrowing.

## createRunSchema.posting.applyUrl not URL-validated

In `src/routes/runs.ts`, `applyUrl` is `z.string()`, but the frontend deep-links it as
the Apply target. Tighten to `z.string().url()` next time the schema is touched.

## Dealbreaker polarity relies on the prompt

The `emit_criteria` schema instructs the model to phrase dealbreakers as requirements
(met = satisfied), and the confidence-gated cap in `score.ts` depends on that convention.
On unusual JDs the model may still emit a disqualifier-phrased dealbreaker, silently
inverting that row's polarity. Mitigation is prompt-level only today — a deterministic
guard (or a post-check that flags suspected inversions) would harden it. A UX follow-up:
surface low-confidence dealbreaker calls to the user rather than silently not-capping.

## Surface run.failed in the UI

The matching state machine records a per-run `failed` counter (`ADD failed :one` on the run
item) each time a posting's chain is caught and skipped, so a run can land `done` with zero
matches yet stay explainable. Nothing reads it back yet: `toRun` in `src/data/run.ts` doesn't
project `failed`, the frontend `domain.ts` Run type has no `failed` field, and the results
screen can't distinguish "all N postings errored" from "genuinely no fits". Coordinated
frontend change: add `failed?` to Run, project it in `toRun`, and surface it (e.g. a banner
when `failed > 0`).

**Priority note (2026-07-04):** no longer hypothetical — run `ef588719` dropped a posting
(the candidate's best match, a React/TS/RN role) with no signal to the user beyond the raw
counter. Also: because the failure is *tolerated* (the Map iteration ends successfully via
RecordFailure), Step Functions redrive can't recover the dropped posting — as far as SFN is
concerned the run completed cleanly. Recovery today means a whole new run; the real fix is a
"rescreen the failed ones" affordance keyed off `failed`. Write that down before it's forgotten.

## callTool robustness — remaining hardening

The self-correcting retry (feed the Zod error back as a Converse `toolResult` error turn) and
the decision-grade failure log (`event`, `label`, `attempt`, `stopReason`, `usage`, `issues`,
`rawInput`) shipped on `feat/calltool-robustness`, motivated by run `ef588719` (a ScorePosting
call twice returned `criteria` as a string / `summary` missing, dropping the posting).
Production sign-off passed 2026-07-04 against `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
via `scripts/calltool-signoff.ts` (attempt 1 failed Zod → Bedrock accepted the toolResult
correction → model recovered). Re-run that harness (`npm run signoff:calltool` with
`BEDROCK_MODEL_ID` set) on any model swap. Still outstanding:

- **Evidence-gated coercion:** now that `rawInput` is logged, if a real failure shows a field
  arriving as stringified JSON, add a targeted `JSON.parse`-before-validate (a two-line
  follow-up). Do not add speculatively.
- **Correlation id in failure logs:** the entry carries `label` but not `postingId`/`runId`
  (callTool is generic). Have each worker `logger.appendKeys({ runId, postingId })` so a
  failure ties to a posting without time-window + SFN-history correlation.
- **Tighten the Score tool input JSON Schema** so `criteria`/`summary` are harder to violate.

Rate signal: filter `llm_validation_exhausted` by `label` for the true per-call-site drop rate,
`llm_validation_retry` for the recoverable-flake rate. Orthogonal to prompt caching (cost /
latency, not output correctness) — don't conflate the two.

## Tenure verification without explicit dates

The Score model marks "5+ years X" as `not_met` when the résumé lists the skill but has
no date ranges to prove duration — defensible, but it systematically fails experience
must-haves for résumés written without dates. Open question for a prompt/parsing pass:
infer tenure from role date ranges, or treat undated experience more leniently.
