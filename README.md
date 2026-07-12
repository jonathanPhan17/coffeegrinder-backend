# Coffee Grinder — Backend

AWS CDK (TypeScript) infrastructure for the Coffee Grinder job-screening pipeline.
Design: [ARCHITECTURE.md](./ARCHITECTURE.md).

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
npm test         # full test suite (vitest) — see Testing below
npm run synth    # cdk synth
npm run deploy   # cdk deploy --all
```

## Testing

```bash
npm test                              # everything (~5s)
npx vitest run lib/api-stack.test.ts  # one file
npx vitest                            # watch mode — re-runs on save
npm run build                         # typecheck; run it alongside the tests as the gate
```

Four kinds of tests. Each test file sits next to the file it tests (`foo.ts` → `foo.test.ts`):

| Kind | Where | What it proves |
|---|---|---|
| Plain unit tests | `src/matching/`, `src/sources/` | Logic with no AWS in it at all: the scoring math, quote verification, input validation |
| Unit tests with AWS faked | `src/ai/`, `src/data/`, `src/routes/` | Our code around Bedrock / DynamoDB / Step Functions, with the AWS responses faked (`aws-sdk-client-mock`) |
| Infrastructure tests | `lib/*.test.ts` | The CloudFormation the CDK generates: prod keeps its data when a stack is deleted, each Lambda gets only the permissions it needs, the workflow is wired correctly |
| Live sign-off | `scripts/calltool-signoff.ts` | The real model recovers when its first answer fails validation. **Not** part of `npm test` — it makes a paid Bedrock call. Run `npm run signoff:calltool` (with `BEDROCK_MODEL_ID` set) whenever the model is swapped |

## Deploy

```bash
npm run deploy                 # → dev (default)
npm run deploy -- -c env=prod  # → prod (retains data resources on stack deletion)
```

Environment defaults to `dev`; pass `-c env=<name>` to target another. Prod also
switches CORS to its allow-list and uses RETAIN removal policies.

### Bedrock prerequisite

The resume worker calls Amazon Bedrock (Claude Sonnet), so before the first deploy:

1. **Enable model access** for the Sonnet model in the Bedrock console, in your deploy
   region. The configured model is a US cross-region inference profile, so deploy to one
   of `us-east-1`, `us-east-2`, `us-west-1`, `us-west-2`.
2. The model id is set in `cdk.json` → `context.bedrockModelId`
   (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`). Override per-deploy with
   `-c bedrockModelId=<id>` or the `BEDROCK_MODEL_ID` env var. `ApiStack` fails fast if
   it is unset.

## Folder structure

```
coffeegrinder-backend/
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
│   └── calltool-signoff.ts       # manual check against the real Bedrock model (costs money)
├── ARCHITECTURE.md               # the design doc — section references like "§7" point here
├── BACKLOG.md                    # deferred work, written so it can be picked up cold
├── CLAUDE.md                     # working conventions for changes in this repo
├── cdk.json                      # how the CDK runs the app + settings (model id, feature flags)
└── vitest.config.ts
```

A few layout choices, so they read as decisions and not accidents: tests live **next to
the files they test** (no separate `test/` folder) so a module and its tests travel
together; per-environment settings live in `cdk.json` + `lib/config.ts` (no `config/`
folder of JSON files); and there is no CI pipeline yet — that is a recorded, deliberate
deferral in [BACKLOG.md](./BACKLOG.md).
