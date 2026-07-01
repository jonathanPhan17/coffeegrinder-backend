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
| Frontend hosting   | S3 + CloudFront (or Vercel)                                            |
| API                | API Gateway (HTTP API) + Lambda (TypeScript, Fastify)                  |
| Async pipeline     | **AWS Step Functions** (Fetch -> Distributed Map -> Persist)          |
| AI                 | **Amazon Bedrock** — Claude (Haiku for extraction, Sonnet/Opus for adjudication) |
| Data               | **DynamoDB** (single-table) + **S3** (resume files)                   |
| Job ingestion      | **Apify** (managed scraping API) behind a swappable `JobSource`        |
| Auth               | Amazon Cognito (added later)                                           |
| Notifications      | EventBridge Scheduler + Gmail API (stretch / V3)                      |

**No VPC anywhere.** DynamoDB, S3, Bedrock, Step Functions, and Apify are all reached
over IAM-authed public AWS APIs (or HTTPS). Avoiding RDS means avoiding the VPC, the
NAT gateway, and connection-pooling — the single biggest cost and complexity savings.

---

## 3. System diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  FRONTEND  — React + TS + Vite + Tailwind/shadcn (cinnamon theme)            │
│  Hosted on S3 + CloudFront (or Vercel)                                        │
│  Screens: Upload · Run config (pick N) · Results (sorted) · Scorecard ·       │
│           Cover-letter drafter · Pipeline board                               │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                 │ HTTPS / JSON
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  API  — API Gateway (HTTP API)  ──►  Lambda handlers (TS, Fastify)            │
│  Routes: POST /resume · POST /runs · GET /runs/{id} · GET /matches            │
│          POST /coverletter · PATCH /matches/{id} (status)                     │
│  Auth: Cognito (added later)                                                   │
└───────┬──────────────────────────┬───────────────────────────┬───────────────┘
        │ upload                    │ start run                  │ read/write
        ▼                           ▼                            ▼
   ┌─────────┐          ┌─────────────────────────┐       ┌──────────────┐
   │   S3    │          │   STEP FUNCTIONS         │       │  DynamoDB    │
   │ resumes │          │   (the matching pipeline)│◄─────►│ (single tbl) │
   └────┬────┘          │                          │       └──────────────┘
        │               │  1. Fetch (Apify)        │
        ▼               │     start run -> wait     │──────► Apify REST API
   parse Lambda         │     (webhook callback)    │        (LinkedIn/Indeed/…)
   (Textract/pdf)       │           │               │
        │               │  2. Distributed Map ──────┼──► fan-out over N postings
        └──► profile     │     per posting:          │
             (DynamoDB)  │       Extract  (Bedrock)  │──────► Amazon Bedrock
                         │       Verify   (Bedrock)  │        (Claude: Haiku +
                         │       Adjudicate(Bedrock) │         Sonnet/Opus)
                         │           │               │
                         │  3. Persist scored matches│──────► DynamoDB
                         └─────────────────────────┘
                                 (no VPC — all IAM + public AWS APIs)

  Cover letters:  POST /coverletter ─► Lambda ─► Bedrock (resume + posting) ─► DynamoDB
  Stretch (V3):   EventBridge Scheduler ─► poll Lambda ─► Gmail API ─► classify reply ─► notify
```

---

## 4. End-to-end flow

1. **Upload** — User uploads a resume PDF via a presigned URL to **S3**. A parse Lambda
   extracts text (Textract or `pdf-parse`), structures it into a profile, stores it in DynamoDB.
2. **Run** — User picks **N** (e.g. "match me against 20 jobs") + search terms and hits Go.
   `POST /runs` starts a **Step Functions** execution and returns a `runId`. The frontend
   polls `GET /runs/{id}` for status.
3. **Fetch** — Step 1 of the state machine calls **Apify**, waits for the run to complete
   (webhook callback), normalizes the results into the standard posting shape (§6),
   and writes N posting rows.
4. **Match (fan-out)** — A **Distributed Map** runs the 3-stage pipeline (§5) on all N
   postings in parallel with a capped concurrency.
5. **Results** — Scored matches are written to DynamoDB; the UI lists them **sorted, best
   first**, each with a **% score** and an expandable **scorecard**.
6. **Act** — Per result: **Apply** (deep-links to the original posting URL) and
   **Draft cover letter** (Bedrock generates one tailored to that posting, versioned in DynamoDB).
7. **Track** — A **pipeline board** moves each match through statuses
   (matched -> shortlisted -> applied -> interviewing -> offer/rejected).
   *(V3: Gmail polling auto-advances "applied -> heard back".)*

---

## 5. The matching pipeline (the core)

Three Bedrock-backed stages, run per posting inside the Distributed Map. Mirrors the
clinical "Agent 1 / Agent 2 / Agent 3" pattern.

| Stage          | Job                                                                    | Model tier            |
|----------------|-----------------------------------------------------------------------|-----------------------|
| **Extract**    | For each criterion, pull supporting evidence snippets from the resume. | Haiku (cheap, high volume) |
| **Verify**     | Score that evidence: is it real, relevant, strong? (confidence 0–1)    | Haiku / mid           |
| **Adjudicate** | Final per-criterion verdict (met / partial / not_met) + overall score + reasoning. | Sonnet / Opus (quality) |

Before matching, each **job posting is parsed into structured criteria** (a separate
LLM call): `{ must_haves[], nice_to_haves[], dealbreakers[] }`. The resume is parsed into
a structured profile once per upload. Tiered model routing (cheap for extraction, strong
for the final call) keeps cost down while protecting verdict quality.

Output per match: an **overall score (%)**, a **verdict**, and a list of **per-criterion
evidence** rows (criterion, met/partial/not_met, confidence, evidence snippet, reasoning) —
this is the explainable scorecard.

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
| Match (scored)      | `RUN#<runId>`   | `MATCH#<postingId>` | GSI1: `USER#<id>` / `STATUS#<status>` (board); score for sort |
| Match evidence      | `MATCH#<id>`    | `EVIDENCE#<crit>`   | per-criterion verdict/confidence/snippet       |
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
| `POST /resume`          | Get presigned upload URL / register a resume       |
| `POST /runs`            | Start a screening run (N, query) -> `runId`        |
| `GET  /runs/{id}`       | Poll run status                                    |
| `GET  /matches?run=…`   | List scored matches (sorted)                       |
| `GET  /matches/{id}`    | One match + its evidence scorecard                 |
| `PATCH /matches/{id}`   | Update pipeline status                             |
| `POST /coverletter`     | Generate/save a tailored cover letter for a match  |

---

## 9. Build phases

**MVP — the demo that sells it (all free, no Apify spend):**
1. CDK foundation: API Gateway + health Lambda + DynamoDB + S3 (no VPC).
2. Resume upload + parse.
3. `PastedSource` -> single match via Step Functions.
4. Scorecard UI: score + per-criterion "why".
5. Scale to N via Distributed Map + configurable count.
6. Sorted results list + deep-link "Apply".

**V2 — makes it feel like a product:**
7. `ApifySource` (real fetched jobs).
8. AI cover-letter / email drafting, tailored + saved.
9. Pipeline board with manual status.

**V3 — the wow (build last):**
10. Gmail follow-up monitoring + notifications (EventBridge + Gmail API).
11. Cognito multi-user auth.

---

## 10. Cost posture

Everything scales to zero except what you explicitly run:
- Lambda, API Gateway, S3, Step Functions, DynamoDB (on-demand) -> ~$0 at rest.
- Bedrock -> pay per token; tiered model routing keeps it low.
- Apify -> usage-based; the "pick N" cap throttles spend.
- No NAT gateway, no always-on RDS, no VPC endpoints.
