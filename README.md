# Coffee Grinder — Backend

The serverless backend for Coffee Grinder, an AI job-matching tool: upload a resume,
point it at a batch of job postings, and get an explainable scorecard for each one —
every score backed by evidence quotes pulled from the actual resume and posting.

Everything here is **Node.js + TypeScript on AWS**: a Fastify HTTP API running on
Lambda, background worker Lambdas, a Step Functions workflow driving each screening run
end to end, DynamoDB and S3 for storage, and Amazon Bedrock (Claude) for the AI steps —
all defined as code with the AWS CDK. Design: [ARCHITECTURE.md](./ARCHITECTURE.md). The
web app lives in [coffee-grinder](https://github.com/jonathanPhan17/coffee-grinder).

## Stacks

- **`Coffeegrinder-Data-<env>`** — DynamoDB single table + S3 resume bucket (stateful;
  RETAIN + PITR in prod).
- **`Coffeegrinder-Api-<env>`** — everything stateless: the HTTP API + a Fastify "lith"
  Lambda serving all routes, the background worker Lambdas (parse the resume, extract
  criteria, score postings, and the three Apify fetch steps), and the Step Functions
  workflow that drives a run end-to-end (fetch → screen → persist; ARCHITECTURE §4).

## Commands

```bash
npm install
npm run dev      # run the Fastify API locally on :3000 (GET /health)
npm run build    # typecheck (tsc --noEmit)
npm run lint     # ESLint with type-aware rules (eslint.config.mjs)
npm test         # full test suite (vitest) — see Testing below
npm run synth    # cdk synth
npm run deploy   # cdk deploy --all
```

## Testing

```bash
npm test                              # everything (~5s)
npx vitest run lib/api-stack.test.ts  # one file
npx vitest                            # watch mode — re-runs on save
npm run build                         # typecheck
npm run lint                          # lint — typecheck + lint + tests together are the gate
```

The same gate also runs automatically on every push: GitHub Actions
(`.github/workflows/ci.yml`) installs dependencies, typechecks, lints, and runs the full
suite.
A red mark on a commit on GitHub means one of those steps failed — the repo's **Actions**
tab shows which step, with the same output you would see locally.

Four kinds of tests. Each test file sits next to the file it tests (`foo.ts` → `foo.test.ts`):

| Kind | Where | What it proves |
|---|---|---|
| Plain unit tests | `src/matching/`, `src/sources/` | Logic with no AWS in it at all: the scoring math, quote verification, input validation |
| Unit tests with AWS faked | `src/ai/`, `src/data/`, `src/routes/` | Our code around Bedrock / DynamoDB / Step Functions, with the AWS responses faked (`aws-sdk-client-mock`) |
| Infrastructure tests | `lib/*.test.ts` | The CloudFormation the CDK generates: prod keeps its data when a stack is deleted, each Lambda gets only the permissions it needs, the workflow is wired correctly |
| Live sign-off | `scripts/calltool-signoff.ts` | The real model recovers when its first answer fails validation. **Not** part of `npm test` — it makes a paid Bedrock call. Run `npm run signoff:calltool` (with `BEDROCK_MODEL_ID` set) whenever either model id is swapped — once per new id |
| Scoring benchmark | `scripts/scoring-benchmark.ts` | Whether a candidate scoring model holds up on real stored postings: fabricated-quote rate (the production verifier), retries, tokens, est. cost. **Not** part of `npm test` — one paid scoring call per posting. Run per model with `npm run benchmark:scoring -- --out scoring-benchmark-<model>.json` (names matching that pattern stay gitignored), then `--compare` the two files |

## Deploy

```bash
npm run deploy                 # → dev (default)
npm run deploy -- -c env=prod  # → prod (retains data resources on stack deletion)
```

Environment defaults to `dev`; pass `-c env=<name>` to target another. Prod also
switches CORS to its allow-list and uses RETAIN removal policies.

### Bedrock prerequisite

The AI workers call Amazon Bedrock on two model tiers — **Claude Sonnet** for match
scoring and **Claude Haiku** for the cheap extraction calls (posting criteria, resume
structuring) — so before the first deploy (and before any deploy that changes an id):

1. **Model access is automatic** — AWS retired the Bedrock console "model access"
   page; serverless models enable on first invocation (Anthropic models may ask a
   first-time account for use-case details once). Both configured models are US
   cross-region inference profiles, so deploy to one of `us-east-1`, `us-east-2`,
   `us-west-1`, `us-west-2`. A runtime `AccessDeniedException` in an AI worker points
   at IAM/SCP restrictions or that one-time use-case form, not a missing console
   toggle.
2. The ids are set in `cdk.json`: `context.bedrockModelId`
   (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`, scoring) and
   `context.bedrockFastModelId` (`us.anthropic.claude-haiku-4-5-20251001-v1:0`,
   extraction). Override per-deploy with `-c bedrockModelId=<id>` /
   `-c bedrockFastModelId=<id>` — the `-c` form only; the same-named env vars are
   read solely when a context entry is absent, and `cdk.json` sets both, so an env var
   is silently ignored under `cdk deploy`. `ApiStack` fails fast if the standard id is
   unset; an empty fast id (`-c bedrockFastModelId=`) is valid and means every call
   uses the standard model, exactly as before the split.
3. On any id change, run `npm run signoff:calltool` with `BEDROCK_MODEL_ID` set to the
   NEW id (the sign-off exercises whatever id is in that env var, whichever tier it will
   serve) — and for a **scoring** model change, run the scoring benchmark first (see
   Testing).

## Folder structure

```
coffeegrinder-backend/
├── .github/
│   └── workflows/
│       └── ci.yml                # GitHub Actions: typecheck + full test suite on every push
├── bin/
│   └── app.ts                    # where the CDK app starts: creates the two stacks, tags everything
├── lib/                          # infrastructure code — defines what gets deployed to AWS
│   ├── config.ts                 # reads settings (env name, model id, ...) from cdk.json into one typed object
│   ├── data-stack.ts             # the stack that stores data: DynamoDB table + S3 bucket for resumes
│   ├── api-stack.ts              # the stack that runs code: HTTP API, all the Lambdas, their permissions
│   ├── *.test.ts                 # tests that check the generated CloudFormation (see Testing)
│   └── constructs/               # reusable building blocks the stacks are made of
│       ├── single-table.ts       #   the DynamoDB table definition
│       ├── resume-bucket.ts      #   the private S3 bucket resumes are uploaded into
│       └── matching-machine.ts   #   the Step Functions workflow that drives a matching run
├── src/                          # application code — what actually runs inside the Lambdas
│   ├── app.ts                    # builds the Fastify server and plugs in the routes
│   ├── handler.ts                # wraps that server so Lambda can run it
│   ├── local.ts                  # runs the same server on your machine (npm run dev)
│   ├── routes/                   # the HTTP endpoints the frontend calls
│   ├── workers/                  # background jobs: parse the resume, fetch jobs, score postings
│   ├── ai/                       # every call to the LLM (Bedrock) lives here
│   ├── matching/                 # the scoring rules: verify evidence quotes, compute the score
│   ├── sources/                  # where job postings come from (pasted text, or Apify scraping)
│   ├── data/                     # reading and writing DynamoDB items (profile, run, match)
│   ├── shared/                   # small helpers used everywhere: AWS clients, env vars, key builders
│   └── types/                    # the TypeScript types shared with the frontend API
├── scripts/
│   ├── calltool-signoff.ts       # manual check against the real Bedrock model (costs money)
│   └── scoring-benchmark.ts      # compares scoring models on real stored postings (costs money)
├── ARCHITECTURE.md               # the design doc — section references like "§7" point here
├── BACKLOG.md                    # deferred work, written so it can be picked up cold
├── CLAUDE.md                     # working conventions for changes in this repo
├── cdk.json                      # how the CDK runs the app + settings (model id, feature flags)
├── eslint.config.mjs             # the lint rules: what counts as a problem beyond type errors
└── vitest.config.ts
```

A few layout choices, so they read as decisions and not accidents: tests live **next to
the files they test** (no separate `test/` folder) so a module and its tests travel
together; per-environment settings live in `cdk.json` + `lib/config.ts` (no `config/`
folder of JSON files); and CI runs checks only (typecheck + lint + tests, no AWS access) —
deploying is still a manual, deliberate act, and a deployment pipeline remains a
recorded deferral in [BACKLOG.md](./BACKLOG.md).
