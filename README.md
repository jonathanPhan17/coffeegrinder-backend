# Coffee Grinder — Backend

AWS CDK (TypeScript) infrastructure for the Coffee Grinder job-screening pipeline.
Design: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Stacks

- **`Coffeegrinder-Data-<env>`** — DynamoDB single table + S3 resume bucket (stateful).
- **`Coffeegrinder-Api-<env>`** — HTTP API + a Fastify "lith" Lambda serving all routes (stateless).

## Commands

```bash
npm install
npm run dev      # run the Fastify API locally on :3000 (GET /health)
npm run build    # typecheck (tsc --noEmit)
npm run synth    # cdk synth
npm run deploy    # cdk deploy --all
```

Environment is selected with `-c env=<name>` (default `dev`); `prod` retains data
resources on stack deletion.
