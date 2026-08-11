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
| AI                 | **Amazon Bedrock** — Claude Sonnet, one grounded scorecard call per posting (Converse API + tool-use JSON, prompt caching) |
| Data               | **DynamoDB** (single-table) + **S3** (resume files)                   |
| Lambda tooling     | Powertools for AWS Lambda (TS) — structured logs/tracing/metrics; Zod at LLM boundaries |
| Testing            | Vitest + aws-sdk-client-mock; CDK assertions for infra invariants (retention, IAM posture, machine graph) |
| Job ingestion      | **Apify** (managed scraping API) behind a swappable `JobSource`        |
| Auth               | Amazon Cognito (added later)                                           |
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
| **Frontend** | React + TS + Vite + Tailwind/shadcn on S3 + CloudFront (`coffeegrinder.app`) | The user | The API, over HTTPS / JSON |
| **API** | API Gateway (HTTP API) → Lambda (TS, Fastify) | Frontend | Presigns S3 uploads · starts Step Functions runs · reads/writes DynamoDB |
| **Resume bucket** | S3 | API (presigned `PUT`) | Emits `ObjectCreated` → EventBridge |
| **Parse worker** | Lambda (`pdf-parse`) | EventBridge S3 object-created, `resumes/` prefix | Reads the S3 object · writes extracted text to the profile (DynamoDB) |
| **Matching pipeline** | Step Functions — Fetch → inline Map → Persist (§9.5) | `POST /runs`, via the API | Fetches from Apify · per posting: Score (Bedrock) + Verify (in code) · writes scored matches to DynamoDB |
| **AI** | Amazon Bedrock — Claude Sonnet, tool-use JSON | Distributed Map (Score) · cover-letter Lambda | Returns strict-JSON scorecards / letter text |
| **Job ingestion** | Apify REST API (behind `JobSource`) | Step Functions Fetch state | Returns normalized postings (§6) |
| **Data** | DynamoDB (single table) | API · workers · Step Functions | Profiles · runs · postings · matches · evidence · letters (§7) |
| **Cover letters** | Lambda | `POST /coverletter` | Bedrock (resume + posting) → DynamoDB |
| **Follow-ups** (V3) | EventBridge Scheduler → poll Lambda → Gmail API | A schedule | Classifies replies → notifies |

*Every hop above is an IAM-authed public AWS API or an HTTPS call — no VPC, no NAT, no
VPC endpoints (see §2).*

---

## 4. End-to-end flow

1. **Upload** — User uploads a resume PDF via a presigned URL to **S3**. The route rejects
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
2. **Run** — User picks **N** (e.g. "match me against 20 jobs") + search terms and hits Go.
   `POST /runs` starts a **Step Functions** execution and returns a `runId`. The frontend
   polls `GET /runs/{id}` for status.
3. **Fetch** — When the run has no pasted postings, the state machine starts an **Apify**
   actor run and **polls it to completion** (StartActorRun → Wait → GetActorStatus → a
   Choice that loops until the run succeeds, fails, or an attempts guard trips), then
   collects the dataset, normalizes it into the standard posting shape (§6), and writes the
   posting rows. (Poll loop, not a webhook — the run stays inside one Step Functions
   execution with no public callback endpoint to expose; see §9.7.)
4. **Match (fan-out)** — An **inline Map** (`maxConcurrency: 5`) runs the scorecard
   evaluation (§5) on all N postings in parallel with a capped concurrency (§9.5).
5. **Results** — Scored matches are written to DynamoDB; the UI lists them **sorted, best
   first**, each with a **% score** and an expandable **scorecard**.
6. **Act** — Per result: **Apply** (deep-links to the original posting URL) and
   **Draft cover letter** (Bedrock generates one tailored to that posting, versioned in DynamoDB).
7. **Track** — A **pipeline board** moves each match through statuses
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
| **Score**      | Criteria + resume in -> strict JSON out: per criterion a verdict (met / partial / not_met), reasoning, and **mandatory verbatim resume quotes as evidence**. Overall score + verdict. | Bedrock — Claude Sonnet, Converse API + tool-use (forced JSON schema), temperature ~0, Zod-validated |
| **Verify**     | String-match every quoted evidence snippet against the actual resume text. A fabricated quote can't match -> flag / downgrade the criterion / retry. | Plain code in the Lambda — free, deterministic |

Before matching, each **job posting is parsed into structured criteria** (a separate
LLM call): `{ must_haves[], nice_to_haves[], dealbreakers[] }`. The resume is parsed into
a structured profile once per upload. The resume + system-prompt prefix repeats across
all N calls in a run — **prompt caching** makes the fan-out's repeated tokens ~90% cheaper.

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

**Access patterns (all covered without joins):**
- Get a user's profile -> key lookup.
- Get a run + its status -> key lookup.
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
| `POST /runs`            | Start a screening run (N, query) -> `runId`        |
| `GET  /runs/{id}`       | Poll run status                                    |
| `GET  /matches[?run=…]` | List scored matches (one run's, or without `run` all of the user's — the pipeline board) |
| `GET  /matches/{id}`    | One match + its evidence scorecard                 |
| `PATCH /matches/{id}`   | Update pipeline status                             |
| `POST /coverletter`     | Generate/save a tailored cover letter for a match  |

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

---

## 10. Cost posture

Everything scales to zero except what you explicitly run:
- Lambda, API Gateway, S3, EventBridge, Step Functions, DynamoDB (on-demand) -> ~$0 at rest.
- Bedrock -> pay per token; one call per posting + prompt caching (resume prefix repeats
  across the fan-out) keeps a full N=20 run in the cents. Apify dominates real spend, not Bedrock.
- Apify -> usage-based; the "pick N" cap throttles spend.
- Domain -> ~$18/yr renewal at the registrar + $0.50/mo for the Route 53 zone; ACM cert
  free; CloudFront/S3 pennies at this traffic.
- No NAT gateway, no always-on RDS, no VPC endpoints.
