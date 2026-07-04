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

## Tenure verification without explicit dates

The Score model marks "5+ years X" as `not_met` when the résumé lists the skill but has
no date ranges to prove duration — defensible, but it systematically fails experience
must-haves for résumés written without dates. Open question for a prompt/parsing pass:
infer tenure from role date ranges, or treat undated experience more leniently.
