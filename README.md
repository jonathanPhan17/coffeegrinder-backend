# Coffee Grinder — Backend

AWS CDK (TypeScript) infrastructure for the Coffee Grinder job-screening pipeline.
Design: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Stacks

- **`Coffeegrinder-Data-<env>`** — DynamoDB single table + S3 resume bucket (stateful).
- **`Coffeegrinder-Api-<env>`** — HTTP API + a Fastify "lith" Lambda serving all routes,
  plus the async resume worker: S3 upload → EventBridge → extract PDF text → structure
  with Bedrock → write the profile (stateless).

## Commands

```bash
npm install
npm run dev      # run the Fastify API locally on :3000 (GET /health)
npm run build    # typecheck (tsc --noEmit)
npm test         # unit tests (vitest)
npm run synth    # cdk synth
npm run deploy   # cdk deploy --all
```

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
