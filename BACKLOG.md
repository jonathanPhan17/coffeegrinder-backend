# Backlog

Deferred items surfaced during implementation. Remove an entry once it's resolved —
this file should only ever reflect what's still outstanding.

## Paste tab (frontend, deferred source)

Build out the disabled "Paste · soon" control in `RunSetupForm.tsx` to send `postings[]` on
`POST /runs` — the backend already accepts pasted postings (schema + `PastedSource` are live;
curl-tested). Purely a frontend form slice behind the existing seam.

## Google sign-in IdP — blocked on Google OAuth client credentials

Email+password signup is live; Google sign-in needs a Google OAuth client (id + secret)
first. Once credentials exist: add a `UserPoolIdentityProviderGoogle` to `AuthStack`
(scopes openid/email/profile, attribute mapping email → email) and list it in the SPA
client's `supportedIdentityProviders` (unset today, meaning Cognito-only). The frontend
needs zero changes — the hosted UI grows a "Continue with Google" button on its own.

## parseFailed handling

`ParseResume` worker throws on parse failure but there's no `parseFailed` state
surfaced to the frontend. Needs a coordinated `domain.ts` change (frontend has no
field for it yet) before this can be picked up. The live upload flow mitigates with
a client-side poll timeout (honest error + retry after ~90s), so a failed parse no
longer hangs the UI — but the user still can't tell "parse failed" from "parse slow".

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

## Dealbreaker polarity relies on the prompt

The `emit_criteria` schema instructs the model to phrase dealbreakers as requirements
(met = satisfied), and the confidence-gated cap in `score.ts` depends on that convention.
On unusual JDs the model may still emit a disqualifier-phrased dealbreaker, silently
inverting that row's polarity. Mitigation is prompt-level only today — a deterministic
guard (or a post-check that flags suspected inversions) would harden it. A UX follow-up:
surface low-confidence dealbreaker calls to the user rather than silently not-capping.

## Rescreen failed postings affordance

Surfacing `run.failed` shipped (backend projects it in `toRun`, frontend banner + failure-aware
progress, both merged 2026-07-10). What remains is recovery: because a posting's scoring
failure is *tolerated* (the Map iteration ends successfully via RecordFailure), Step Functions
redrive can't recover a dropped posting — as far as SFN is concerned the run completed cleanly.
Recovery today means a whole new run. The real fix is a "rescreen the failed ones" affordance
keyed off `failed` (motivating case: run `ef588719` dropped the candidate's best match, a
React/TS/RN role).

## callTool robustness — remaining hardening

The self-correcting retry (feed the Zod error back as a Converse `toolResult` error turn) and
the decision-grade failure log (`event`, `label`, `attempt`, `stopReason`, `usage`, `issues`,
`rawInput`) shipped on `feat/calltool-robustness`, motivated by run `ef588719` (a ScorePosting
call twice returned `criteria` as a string / `summary` missing, dropping the posting).
Production sign-off passed 2026-07-04 against `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
via `scripts/calltool-signoff.ts` (attempt 1 failed Zod → Bedrock accepted the toolResult
correction → model recovered), and 2026-08-10 against
`us.anthropic.claude-haiku-4-5-20251001-v1:0` ahead of the fast-tier rollout. Re-run that
harness (`npm run signoff:calltool` with `BEDROCK_MODEL_ID` set) on any model swap. Still outstanding:

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

## Apify "no jobs found" empty state (frontend, coordinated)

An Apify run whose query matches nothing lands `done` with `count: 0` (correct, and
distinguishable from `error`). The backend is right; the risk is on the frontend results
screen, which must render a "no jobs matched your search" empty state rather than a blank
`0/0` progress bar or an empty results list. Pairs with the mock->live cutover slice —
pick it up when the results screen next gets touched.

## Apify charge-then-save breadcrumb gap

`StartActorRun` POSTs to Apify (starts a paid run), then `saveApifyRunId` persists the run id.
If the save fails after the POST succeeds, a charged run has no breadcrumb on the run item.
Inherent to any charge-then-record sequence and bounded by the per-run cost cap (one run's
worth), so not actionable today — recorded so it is a known, accepted gap rather than a
surprise. A real fix would need an idempotency/outbox layer, which is overkill at this scale.

## Scraping -> official job-board API graduation path

`ApifySource` (§9.7) scrapes Indeed via the misceres/indeed-scraper actor. For personal use
this is low-risk, but **serving scraped job data to third-party users raises ToS exposure**
(Apify owns the proxy/anti-bot layer, yet redistribution is a different question than personal
scraping). If Coffeegrinder gets real external-user traction, make it a conscious decision to
move to official job-board APIs / partnerships rather than scraped data. Gate this on the
external-user milestone (whose first slice, run quotas, shipped 2026-08 -- ARCHITECTURE 9.12).
Noting now so it is deliberate later, not a surprise.

## Cross-run dedup / caching of fetched postings

Deferred from the Apify slice. `sourceId` is Indeed's stable job id (not a random UUID), so the
groundwork for dedup is in place: the same posting fetched in two runs shares an id. At
multi-user scale, caching identical-query results for a short window avoids paying Apify twice
for the same search. Keep deferred until there is real multi-user traffic — tie it to the same
external-user milestone as the API-graduation item above (run quotas, its first slice, shipped
2026-08). Not worth building while one person uses the app.

## cdk-nag security linting pass

From the CDK best-practices review (2026-07-11): add cdk-nag's AwsSolutions pack as an
app-level aspect and triage its findings one by one — fix, or suppress with a written reason.
Valuable but its own slice: the first synth will emit a pile of findings that each need a
decision. Ungated; pick up whenever a security-posture pass is wanted.

## Deployment pipeline + integration/deploy-time testing (conscious workflow change)

From the same review, three related maturity items, all gated on the external-user/prod
milestone (whose first slice, run quotas, shipped 2026-08). Test-only CI (typecheck + vitest on every push,
zero AWS access) shipped 2026-07-11 as `.github/workflows/ci.yml` — what remains here is
the deployment half only:

- **CDK Pipelines (or extending the GitHub Actions workflow to deploy).** NOTE: a pipeline
  auto-deploys, which deliberately changes the current run-deploys-by-hand workflow — adopt
  only as a conscious decision, not as a default. If extending GitHub Actions: authenticate
  via OIDC provider + roles (bootstrapped once by a small separate CDK app), never
  long-lived access keys in repo secrets.
- **integ-runner integration tests** — deploys real stacks and flags destructive diffs
  (e.g. a table key change that would wipe data) as part of review.
- **Deploy-time smoke validation** — a triggers-module / intrinsic-validator custom resource
  that hits `/health` (or runs a fetch->screen canary) during stack update and rolls back on
  failure.

## Dev-dependency audit findings (vitest 2.x chain)

`npm audit` (surfaced 2026-07-11 during the lint slice) reports 5 findings, all in the
dev-only vitest/esbuild chain — nothing in production dependencies: vitest@2.1.9
(critical), vite (high, transitive), esbuild <=0.24.2 (moderate), plus @vitest/mocker and
vite-node (moderate, transitive). Exposure is local dev/CI only (the esbuild advisory is a
malicious-website-vs-dev-server issue), so no urgency. The fix is its own slice: bump
vitest to 3.x and esbuild to a current 0.2x, then run the full gate — and because esbuild
is also what CDK NodejsFunction uses to bundle the Lambdas, follow the bump with a dev
deploy sanity check.

## Node 20 -> 22 bump (Lambda runtime + CI together)

The first CI run (2026-07-11) surfaced an AWS SDK warning: SDK v3 versions published after
the first week of January 2027 require Node >= 22. We pin Node 20 in two places on purpose
so CI matches production — bump BOTH in the same commit: `NODEJS_20_X` -> `NODEJS_22_X` in
`lib/api-stack.ts` (the `nodeFunction` helper) and `node-version: 20` -> `22` in
`.github/workflows/ci.yml`. No urgency until late 2026; after the bump, run the full gate
plus a dev deploy to confirm the Lambdas run clean on the new runtime.

## Tenure verification without explicit dates

The Score model marks "5+ years X" as `not_met` when the résumé lists the skill but has
no date ranges to prove duration — defensible, but it systematically fails experience
must-haves for résumés written without dates. Open question for a prompt/parsing pass:
infer tenure from role date ranges, or treat undated experience more leniently.
