# Backlog

Deferred items surfaced during implementation. Remove an entry once it's resolved —
this file should only ever reflect what's still outstanding.

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

## Malformed Score output silently drops matches (callTool robustness)

First production incident (run `ef588719`, 2026-07-04): one of three ScorePosting calls failed
and its posting was dropped from the results. Cause pinned from the SFN history + Powertools
logs — **not** throttling, `max_tokens`, or a Lambda timeout (execution ran 24s; a single
TaskFailed with no retry cycle, and the error was `match scoring failed schema validation after
retry`). Both `callTool` attempts returned the same Zod issues: `criteria` as a **string**
(expected array) and `summary` **missing**. So the Score model intermittently emits malformed
tool input; at temp ~0 it was stable-wrong within the run (both retries identical) but a fresh
run scored the same posting fine. Observed rate so far: 1 of 6 Score calls — at N=50 that is
several silent drops per run if it holds.

Fix candidates, best placed in the shared `callTool` spine so every caller (structure /
criteria / score) benefits:
- **Self-correcting retry** — the retry re-sends the identical prompt today; feed the Zod error
  back in ("your previous output had `criteria` as a string; return an array") so the model can
  repair instead of repeating the mistake.
- **Tolerant coercion** — if a field arrives as a JSON string, `JSON.parse` before validating.
  Can't confirm this would have recovered the incident (see next).
- **Log raw output on validation failure** — the WARN logs the Zod issues but not a preview of
  the model's actual output, and carries no postingId/runId (had to correlate by time window +
  SFN history). Add a truncated raw-output preview and a correlation id so the next incident is
  diagnosable without guessing.
- **Tighten the Score tool input JSON Schema** so `criteria`/`summary` are harder to violate.

Orthogonal to prompt caching — caching cuts cost/latency but does nothing for output
correctness; don't conflate the two.

## Tenure verification without explicit dates

The Score model marks "5+ years X" as `not_met` when the résumé lists the skill but has
no date ranges to prove duration — defensible, but it systematically fails experience
must-haves for résumés written without dates. Open question for a prompt/parsing pass:
infer tenure from role date ranges, or treat undated experience more leniently.
