# Coffee Grinder — Architecture

> An automated job-screening pipeline for a single candidate against many postings.
> Upload a resume, fetch N job postings, and an AI pipeline screens each one and
> returns an explainable, scored match — best fit at the top.

The conceptual model is borrowed from clinical-trial patient screening (structured
eligibility criteria + a multi-stage AI evaluation + an explainable verdict), flipped:
instead of *many patients vs. one trial's criteria*, it is *one resume vs. many jobs' criteria*.

---

## 1. Goals & non-goals

**Goals**
- Eliminate the manual labor of reading each posting and judging fit by hand.
- Produce a **scored, sorted, explainable** evaluation per job ("matched 8/11 must-haves, here's why").
- Be **serverless, scale-to-zero, and cheap at rest** (a portfolio project, not a funded product).
- Be a strong portfolio artifact: AWS-native, fully defined as Infrastructure-as-Code.

**Non-goals (for now)**
- Multi-tenant scale / heavy concurrency.
- Analytics dashboards / aggregations (DynamoDB is not built for ad-hoc queries — see §7).
- Semantic search across postings (would require a vector store — deferred).
- Auto-applying to jobs (we deep-link to the original posting; the user applies).

---

## 2. Stack at a glance

| Concern            | Choice                                                                 |
|--------------------|-----------------------------------------------------------------------|
| IaC                | **AWS CDK (TypeScript)**                                               |
| Frontend           | React + TypeScript + Vite + Tailwind / shadcn (cozy "cinnamon" theme) |
| Frontend hosting   | **S3 + CloudFront** on `coffeegrinder.app` — private bucket behind OAC, Route 53 zone (domain registered externally, DNS delegated in), us-east-1 ACM cert stack; app ships via s3 sync from the frontend repo, never `cdk deploy` |
| API                | API Gateway (HTTP API) + Lambda (TypeScript, Fastify)                  |
| Async triggers     | **EventBridge** (S3 object-created -> workers; keeps cross-stack deps one-directional) |
| Async pipeline     | **AWS Step Functions** (Fetch -> inline Map -> Persist; §9.5)         |
| AI                 | **Amazon Bedrock** — two Claude model tiers (standard = the grounded scorecard call, fast = the extraction-class calls: criteria, resume structuring); both currently Haiku 4.5. Converse API + tool-use JSON, prompt caching |
| Data               | **DynamoDB** (single-table) + **S3** (resume files)                   |
| Lambda tooling     | Powertools for AWS Lambda (TS) — structured logs/tracing/metrics; Zod at LLM boundaries |
| Testing            | Vitest + aws-sdk-client-mock; CDK assertions for infra invariants (retention, IAM posture, machine graph) |
| Job ingestion      | **Apify** (managed scraping API) behind a swappable `JobSource`        |
| Auth               | **Amazon Cognito** — user pool (open email+password signup, hosted UI, no-secret PKCE SPA client) in its own stateful `AuthStack`; an HTTP API JWT authorizer verifies every route at the gateway (carve-outs: `GET /health` and CORS preflight `OPTIONS`) |
| Notifications      | EventBridge Scheduler + Gmail API (stretch / V3)                      |

**No VPC anywhere.** DynamoDB, S3, Bedrock, Step Functions, and Apify are all reached
over IAM-authed public AWS APIs (or HTTPS). Avoiding RDS means avoiding the VPC, the
NAT gateway, and connection-pooling — the single biggest cost and complexity savings.

---

## 3. System components

Each node in the flow is one row; the last two columns preserve the arrows' direction —
what invokes a component (upstream) and what it calls or writes (downstream). The
end-to-end *sequence* is narrated in §4.

| Component | Tech | Invoked by | Calls / reads / writes |
|-----------|------|-----------|------------------------|
| **Frontend** | React + TS + Vite + Tailwind/shadcn on S3 + CloudFront (`coffeegrinder.app`) | The user | The API, over HTTPS / JSON, with a Cognito JWT on every request |
| **Auth** | Amazon Cognito user pool + hosted UI + SPA client (no secret, PKCE) | Browser redirects for signup / login | Mints the JWTs the API's authorizer verifies; the token's `sub` is the per-request user id |
| **API** | API Gateway (HTTP API, JWT authorizer) → Lambda (TS, Fastify) | Frontend | Presigns S3 uploads · starts Step Functions runs · reads/writes DynamoDB |
| **Resume bucket** | S3 | API (presigned `PUT`) | Emits `ObjectCreated` → EventBridge |
| **Parse worker** | Lambda (`pdf-parse`) | EventBridge S3 object-created, `resumes/` prefix | Reads the S3 object · writes extracted text to the profile (DynamoDB) |
| **Matching pipeline** | Step Functions — Fetch → inline Map → Persist (§9.5) | `POST /runs`, via the API | Fetches from Apify · per posting: Score (Bedrock) + Verify (in code) · writes scored matches to DynamoDB |
| **AI** | Amazon Bedrock — Claude Haiku 4.5 on both tiers (scoring + extraction), tool-use JSON | Inline Map (Score) · cover-letter Lambda | Returns strict-JSON scorecards / letter text |
| **Job ingestion** | Apify REST API (behind `JobSource`) | Step Functions Fetch state | Returns normalized postings (§6) |
| **Data** | DynamoDB (single table) | API · workers · Step Functions | Profiles · runs · postings · matches · evidence · letters (§7) |
| **Cover letters** | Lambda | `POST /coverletter` | Bedrock (resume + posting) → DynamoDB |
| **Follow-ups** (V3) | EventBridge Scheduler → poll Lambda → Gmail API | A schedule | Classifies replies → notifies |

*Every hop above is an IAM-authed public AWS API or an HTTPS call — no VPC, no NAT, no
VPC endpoints (see §2).*

---

## 4. End-to-end flow

1. **Sign in** — The browser signs up / logs in via the **Cognito hosted UI** (email +
   password, open signup) and attaches the Cognito-minted JWT to every API request. The
   HTTP API's **JWT authorizer** validates it at the gateway — unauthenticated junk dies
   there without ever invoking (or billing) a Lambda — and the lith reads the token's
   `sub` claim as the per-request `userId`. Only `GET /health` and CORS preflight
   `OPTIONS` requests skip this.
2. **Upload** — User uploads a resume PDF via a presigned URL to **S3**. The route rejects
   non-PDF types (415) and anything over **10 MB** (413), and the presigned URL signs
   `content-type` and `content-length`, so S3 itself refuses a body whose type or size
   differs from what was validated — the cap holds even against a client that skips the
   API contract. An **EventBridge
   rule** (S3 object-created, `resumes/` prefix) triggers a parse Lambda that extracts text
   with `pdf-parse` and stores it on the profile in DynamoDB. The
   profile write is conditional on the event's S3 key matching the profile's current key,
   so stale/duplicate events are no-ops. Textract was considered and rejected: resumes are
   digital-native PDFs (no OCR needed) and the text feeds an LLM that tolerates rough layout.
   *(EventBridge — not a direct S3 bucket notification — because the bucket lives in the
   stateful stack and the worker in the stateless one; a bucket notification would reference
   the Lambda ARN from the bucket's stack and create a circular stack dependency.)*
3. **Run** — User picks **N** (e.g. "match me against 20 jobs") + search terms and hits Go.
   `POST /runs` first consumes a run-quota slot (5 runs/month per account plus a 25
   runs/day site-wide backstop, both counters bumped in one conditional DynamoDB
   transaction; see 9.12) and rejects an over-quota request with a 429 **before anything
   is persisted or charged**. Within quota, it starts a **Step Functions** execution and
   returns a `runId`. The frontend polls `GET /runs/{id}` for status.
4. **Fetch** — When the run has no pasted postings, the state machine starts an **Apify**
   actor run and **polls it to completion** (StartActorRun → Wait → GetActorStatus → a
   Choice that loops until the run succeeds, fails, or an attempts guard trips), then
   collects the dataset, normalizes it into the standard posting shape (§6), and writes the
   posting rows. (Poll loop, not a webhook — the run stays inside one Step Functions
   execution with no public callback endpoint to expose; see §9.7.)
5. **Match (fan-out)** — An **inline Map** (`maxConcurrency: 5`) runs the scorecard
   evaluation (§5) on all N postings in parallel with a capped concurrency (§9.5).
6. **Results** — Scored matches are written to DynamoDB; the UI lists them **sorted, best
   first**, each with a **% score** and an expandable **scorecard**.
7. **Act** — Per result: **Apply** (deep-links to the original posting URL) and
   **Draft cover letter** (Bedrock generates one tailored to that posting, versioned in DynamoDB).
8. **Track** — A **pipeline board** moves each match through statuses
   (matched -> shortlisted -> applied -> interviewing -> offer/rejected).
   *(V3: Gmail polling auto-advances "applied -> heard back".)*

---

## 5. The matching pipeline (the core)

One grounded Bedrock call per posting inside the Distributed Map, followed by a
**deterministic verification step in plain code**. This evolved from the clinical
"Agent 1 / Agent 2 / Agent 3" pattern (Extract / Verify / Adjudicate as three LLM
calls) — see the rationale below.

| Stage          | Job                                                                    | Runs on               |
|----------------|-----------------------------------------------------------------------|-----------------------|
| **Score**      | Criteria + resume in -> strict JSON out: per criterion a verdict (met / partial / not_met), reasoning, and **mandatory verbatim resume quotes as evidence**. Overall score + verdict. | Bedrock — Claude Haiku (standard tier), Converse API + tool-use (forced JSON schema), temperature ~0, Zod-validated |
| **Verify**     | String-match every quoted evidence snippet against the actual resume text. A fabricated quote can't match -> flag / downgrade the criterion / retry. | Plain code in the Lambda — free, deterministic |

Before matching, each **job posting is parsed into structured criteria** (a separate
LLM call): `{ must_haves[], nice_to_haves[], dealbreakers[] }`. The resume is parsed into
a structured profile once per upload. The resume + system-prompt prefix repeats across
all N calls in a run — **prompt caching** makes the fan-out's repeated tokens ~90% cheaper.

**Two model tiers.** The extraction-class calls (posting criteria, resume structuring)
pull stated facts out of one document into a Zod-checked shape — a cheaper model does that
job, so they run on a **fast tier** (Haiku; `BEDROCK_FAST_MODEL_ID`, falling back to the
standard id when unset). The Score call is where judgment quality shows up in the product,
so it runs the **standard tier** and moves only on `scripts/scoring-benchmark.ts` evidence
(fabricated-quote rate + verified verdict mix vs the shipped model on real stored
postings), never as a config default. That evidence landed 2026-08-11: Haiku 4.5 matched
Sonnet 4.5's verified verdict mix within 4 of 121 criteria, zero validation retries, and
its fabricated quotes (mean 0.04) were all caught by the deterministic verifier — at
~2.6x lower cost and half the latency — so the standard tier now also runs Haiku 4.5.
The two-tier seam stays in place for the next swap. Every call logs token usage + model id —
success `tokens` entries plus per-attempt failure warns. Run-count quotas (see 9.12) bound
how many runs an account can start, but they are not a token spend meter -- a true
per-user spend meter remains future work, and must sum success and failure entries both,
because retried attempts bill too.

Output per match: an **overall score (%)**, a **verdict**, and a list of **per-criterion
evidence** rows (criterion, met/partial/not_met, verified evidence quote, reasoning) —
this is the explainable scorecard.

**Why one call instead of three.** The quality trick that made staging valuable is
evidence-grounding — verdicts anchored to verbatim quotes, not vibes — and that survives
in a single call once the schema *requires* quotes and code verifies them. What the
3-call version added on top was cost, latency, 3x the Bedrock-quota burn per posting
(the real scaling ceiling), and two extra stochastic/schema boundaries where variance
compounds. An LLM "Verify" stage emitting confidence floats is weaker than a free
string-match. Each posting is still its own Step Functions chain, so splitting Score
back into stages later is a one-state change, not a redesign.

**Scale path (deferred).** At N in the hundreds+, add an **embedding pre-rank** state
*before* the Distributed Map: embed resume + postings (Bedrock embeddings), cosine-rank,
and run the Score call only on the top K. The map already treats its input as
"ranked/filtered postings", so the funnel drops in as one new state with nothing
downstream changing. Not built until real volume demands it.

**No LLM frameworks.** Step Functions is the orchestrator and the Bedrock SDK call is
~15 lines; LangChain/LlamaIndex would duplicate the orchestration behind an opaque
abstraction. Plain SDK + Zod only.

---

## 6. Job ingestion — swappable `JobSource`

The matcher consumes a **normalized posting** and never knows where it came from.

```ts
// The shape every source produces and the matcher consumes.
interface JobPosting {
  sourceId: string;        // id within the source
  source: 'apify' | 'pasted';
  title: string;
  company: string;
  location?: string;
  remote?: boolean;
  description: string;     // raw JD text
  applyUrl: string;        // deep-link back to the original posting
  salary?: { min?: number; max?: number; currency?: string; interval?: string };
  postedAt?: string;
}

interface JobSource {
  fetch(input: { query: string; location?: string; limit: number }): Promise<JobPosting[]>;
}
```

Implementations:
- **`PastedSource`** — user pastes a URL/JD text. Free, zero risk. Used for MVP + local dev.
- **`ApifySource`** — calls the Apify REST API (start actor run -> webhook/poll -> collect
  dataset -> normalize). Managed proxies/anti-bot; usage-based cost. Used for real fetching.

> **Note on LinkedIn:** scraping LinkedIn directly violates their ToS and requires
> proxies/anti-bot. We do not build or maintain a scraper. Apify (or another managed
> provider) owns that exposure; we just call an API. The "pick N" feature also acts as a
> cost throttle.

---

## 7. Data model — DynamoDB single table

| Entity              | PK              | SK                  | Notes / GSIs                                  |
|---------------------|-----------------|---------------------|-----------------------------------------------|
| User profile/resume | `USER#<id>`     | `PROFILE`           | structured profile + S3 key of raw file       |
| Run                 | `USER#<id>`     | `RUN#<runId>`       | status, N, search terms                        |
| Job posting         | `RUN#<runId>`   | `POSTING#<id>`      | normalized `JobPosting` + parsed criteria      |
| Match (scored)      | `RUN#<runId>`   | `MATCH#<postingId>` | embeds `evidence[]`; GSI1: `USER#<id>` / `STATUS#<status>` (board + id lookup); score for sort |
| Match evidence      | *(embedded)*    | —                   | lives on the Match item as `evidence[]` (one query for `GET /matches?run=`); split to `MATCH#<id>` / `EVIDENCE#<crit>` rows only if it outgrows the 400 KB item |
| Cover letter        | `MATCH#<id>`    | `LETTER#<version>`  | versioned drafts                               |
| Quota counter (user monthly) | `USER#<id>` | `QUOTA#<yyyy-mm>` | `used` = runs consumed this UTC month (see 9.12); period lives in the key, so no TTL/reset job |
| Quota counter (global daily) | `QUOTA#GLOBAL` | `DAY#<yyyy-mm-dd>` | `used` = runs consumed site-wide this UTC day |

**Access patterns (all covered without joins):**
- Get a user's profile -> key lookup.
- Get a run + its status -> key lookup.
- Consume a run slot -> one TransactWriteItems bumping both quota counters with a
  `used < limit` condition each (release = best-effort conditional decrement).
- Remaining quota (`GET /quota`) -> two key lookups.
- List a run's postings / matches -> item-collection query.
- Results sorted by score -> fetch run's matches and sort in Lambda (N is small), or encode
  score into a GSI sort key.
- Pipeline board grouped by status -> GSI1 query.
- Evidence / cover letters for a match -> item-collection query.

**Known limitations (accepted):**
- No ad-hoc aggregations/analytics (would need Streams + counters, or export to Athena).
- No vector/semantic search (would need OpenSearch / S3 Vectors).
- Access patterns must be modeled up front; new ones may need new GSIs (cheap to add).
- 400 KB max item size — fine for our blobs; if anything grows huge, store raw in S3 and
  keep structured/queryable fields in DynamoDB.

---

## 8. API surface (initial)

| Method & route          | Purpose                                            |
|-------------------------|----------------------------------------------------|
| `POST /resume`          | Get presigned upload URL (PDF, ≤ 10 MB) / register a resume |
| `POST /runs`            | Start a screening run (N, query) -> `runId`; 429 `{ error, code: monthly_quota \| daily_cap, limit, resetsAt }` when over quota (see 9.12) |
| `GET  /runs/{id}`       | Poll run status                                    |
| `GET  /quota`           | Remaining run quota, both windows: `{ monthly, daily }`, each `{ used, limit, remaining, resetsAt }` |
| `GET  /matches[?run=…]` | List scored matches (one run's, or without `run` all of the user's — the pipeline board) |
| `GET  /matches/{id}`    | One match + its evidence scorecard                 |
| `PATCH /matches/{id}`   | Update pipeline status                             |
| `POST /coverletter`     | Generate/save a tailored cover letter for a match  |

Every route except `GET /health` (and CORS preflight `OPTIONS`) requires a Cognito-minted JWT (`Authorization: Bearer …`),
verified by the HTTP API's user-pool authorizer before the Lambda is invoked; the token's
`sub` claim is the `userId` every read and write is scoped to.

---

## 9. Build phases

**MVP — the demo that sells it (all free, no Apify spend):**
1. CDK foundation: API Gateway + health Lambda + DynamoDB + S3 (no VPC).
2. Resume upload + parse.
   *As built: the presigned PUT signs `content-type` and `content-length` (10 MB cap; the
   route also 413s a larger declared size before touching the stored profile), and the
   shared S3 client sets `requestChecksumCalculation: WHEN_REQUIRED` — the SDK's
   post-3.729 default bakes an empty-body CRC32 checksum into presigned URLs, and S3
   would reject every real browser PUT made with them.*
3. `PastedSource` -> single match via Step Functions.
4. Scorecard UI: score + per-criterion "why".
5. Scale to N via Distributed Map + configurable count.
   *Built with an **inline Map** (`maxConcurrency: 5`) over the run's `postingIds`, not a
   Distributed Map. For N ≤ 50 (the `count` cap) the inline Map needs no S3 ItemReader and
   keeps the whole run in one execution — simpler, and the concurrency cap already protects
   Bedrock. A per-item catch records a `failed` counter on the run and skips the posting so
   one bad JD can't sink the run; each success bumps `screened` for live progress. **Swap to
   a Distributed Map** (S3-sourced items, native tolerated-failure %, per-item child
   executions) when `ApifySource` (phase 7) pushes N into the hundreds.*
6. Sorted results list + deep-link "Apply".

**V2 — makes it feel like a product:**
7. `ApifySource` (real fetched jobs).
   *Built + live-proven. Because an Apify run outlasts the API Gateway 29s timeout, the
   fetch is **not** a synchronous `JobSource.fetch()` — it is an async stage inside the
   state machine: `resolveSource` picks pasted-vs-Apify by whether the request carried
   `postings[]`, then a poll loop (StartActorRun → Wait → GetActorStatus → Choice, capped
   by an attempts guard) drives the actor run to completion before collect + normalize.
   Token in SSM SecureString; two-tier Zod trust boundary (bad row dropped, bad dataset
   fails the run); `retryOnServiceExceptions:false` + immediate `saveApifyRunId` guard the
   double-charge. `PastedSource` remains the synchronous `JobSource` for local dev.*
8. AI cover-letter / email drafting, tailored + saved.
9. Pipeline board with manual status.

**V3 — the wow (build last):**
10. Gmail follow-up monitoring + notifications (EventBridge + Gmail API).
11. Cognito multi-user auth.
    *Pulled forward and shipped ahead of promoting the site. An `AuthStack` user pool
    (open email+password signup, hosted UI, no-secret PKCE SPA client) feeds an
    `HttpUserPoolAuthorizer` set as the HTTP API's **default authorizer** — junk dies at
    the gateway without invoking (or billing) the lith; the exempt routes are `GET /health`
    (probes) and `OPTIONS /{proxy+}` (CORS preflights carry no Authorization header, and
    without the carve-out the JWT-locked `$default` would 401 them at the gateway and
    block every cross-origin call from the site — the documented HTTP API
    $default-plus-authorizer gotcha). Access-token validation (the aud-or-client_id check) is the JWT
    authorizer's job, not app code. In the app, identity is a **seam**:
    `buildApp({ identityExtractor })` — tests inject a fixed id, `local.ts` runs as
    `local-dev`, and production omits the option, so the only identity path is the
    gateway-verified JWT's `sub` read from the adapter-decorated Lambda event; no header
    is ever consulted, so nothing is spoofable. Threading the real `sub` also closed the
    one cross-tenant hole: `GET /matches?run=` now checks run ownership
    (`getRun(userId, runId)`, 404 otherwise) before the RUN#-keyed match query, because
    postings/matches are not user-keyed. Google sign-in is deferred pending OAuth client
    credentials (BACKLOG).*
12. Run quotas (free tier).
    *Shipped 2026-08, the external-user follow-through on open signup: **5 runs/month per
    account** plus a **25 runs/day site-wide** blast-radius backstop, both enforced in
    `POST /runs` before anything is persisted or charged. One DynamoDB TransactWriteItems
    (the repo's first) bumps both period counters (`USER#<id>/QUOTA#<yyyy-mm>`,
    `QUOTA#GLOBAL/DAY#<yyyy-mm-dd>`, see the section 7 table) with a `used < limit`
    condition each -- atomic increment-and-check, so a tripped second guard never leaves
    the first counter consumed and no compensation logic is needed on the reject path.
    Any post-consume failure (pasted-posting write, run write, SFN kickoff) releases the
    slot best-effort (conditional `ADD used -1`, floored at zero) so a failed kickoff
    cannot burn a free run. Period-encoded keys mean no TTL and no reset job: a new
    month/day starts a fresh item, and stale counters (~13 tiny rows per user per year)
    are accepted. `GET /quota` exposes both windows (`used`/`limit`/`remaining`/`resetsAt`)
    for the frontend meter, and the 429 body carries a machine-readable `code`
    (`monthly_quota` / `daily_cap`) -- a deliberate addition to the house `{ error }`
    shape, because two 429 variants need discrimination. Limits are constants in
    `src/shared/constants.ts` (not env-plumbed -- zero CDK diff). Quotas count runs, not
    tokens (see the section 5 spend-meter note). The monthly AWS Budgets alarm
    (account-level, created via CLI, outside CDK) stays as the last-resort tripwire.*

---

## 10. Cost posture

Everything scales to zero except what you explicitly run:
- Lambda, API Gateway, S3, EventBridge, Step Functions, DynamoDB (on-demand) -> ~$0 at rest.
- Bedrock -> pay per token; one call per posting + prompt caching (resume prefix repeats
  across the fan-out) keeps a full N=20 run in the cents, and the extraction-class calls
  (criteria, resume structuring) run on the cheaper fast tier (§5). Apify dominates real
  spend, not Bedrock.
- Apify -> usage-based; the "pick N" cap throttles per-run spend, and the run quotas
  (see 9.12) bound volume -- worst case ~25 paid runs/day site-wide.
- Domain -> ~$18/yr renewal at the registrar + $0.50/mo for the Route 53 zone; ACM cert
  free; CloudFront/S3 pennies at this traffic.
- No NAT gateway, no always-on RDS, no VPC endpoints.
