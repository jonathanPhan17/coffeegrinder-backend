// Opt-in production sign-off for callTool's self-correcting retry. NOT run in CI — invoke
// it by hand, and re-run it on every BEDROCK_MODEL_ID swap (model changes carry edges, e.g.
// how a new model behaves at temperature 0).
//
// It runs the SHIPPED callTool unmodified against live Bedrock. The trick is a Zod schema
// stricter than the tool's JSON schema in a *satisfiable* way: the tool allows `token` but
// does not require it, so attempt 1 emits a normal `{ ok: true }` that passes the tool yet
// fails Zod. That produces a genuine validation failure — the exact shape production hits —
// so the real correction turn fires (assistant toolUse + user toolResult error). If Bedrock
// accepts that sequence and the model complies with the echoed error, callTool returns,
// proving the round-trip end to end.
//
// Usage (PowerShell):
//   $env:BEDROCK_MODEL_ID="us.anthropic.claude-sonnet-4-5-20250929-v1:0"; npx ts-node scripts/calltool-signoff.ts
// Usage (bash):
//   BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0 npx ts-node scripts/calltool-signoff.ts

import { z } from 'zod';
import { callTool } from '../src/ai/tool-call';

const TOKEN = 'SIGNED-OFF';

// Stricter than the tool schema below: `token` must equal TOKEN. The model won't guess it on
// attempt 1, so validation fails and the correction echoes "expected \"SIGNED-OFF\"", which
// the model can satisfy on attempt 2.
const schema = z.object({
  ok: z.boolean(),
  token: z.literal(TOKEN),
});

async function main(): Promise<void> {
  if (!process.env.BEDROCK_MODEL_ID) {
    throw new Error('set BEDROCK_MODEL_ID (the id prod injects) before running the sign-off');
  }
  console.log(`[signoff] model=${process.env.BEDROCK_MODEL_ID}`);
  console.log('[signoff] expecting: one llm_validation_retry at attempt 1, then a returned result\n');

  try {
    const result = await callTool(schema, {
      toolName: 'emit_check',
      toolDescription: 'Emit a readiness check result.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', description: 'Set to true.' },
            token: { type: 'string', description: 'Only include when a correction tells you the exact value.' },
          },
          required: ['ok'],
        },
      },
      systemPrompt: 'You call the emit_check tool. Follow any tool-result correction exactly.',
      userText: 'Call emit_check with ok set to true.',
      label: 'signoff check',
    });

    console.log('\n[signoff] result:', JSON.stringify(result));
    console.log(
      '[signoff] PASS — attempt 1 failed Zod, Bedrock accepted the toolResult correction, and the model recovered on retry. The self-correcting retry works end to end against this model.',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'unknown';
    console.error(`\n[signoff] callTool threw (${name}): ${message}`);
    if (message.includes('failed schema validation after retry')) {
      console.error(
        '[signoff] INCONCLUSIVE — Bedrock accepted the calls (no API error) but the model never satisfied the strict schema across the retries. Re-run; if it persists, strengthen the correction text, not the sequence.',
      );
    } else {
      console.error(
        '[signoff] FAIL — a Bedrock API error, not a schema miss. If this is a ValidationException on the retry, the assistant-toolUse + user-toolResult(error) sequence under forced toolChoice was rejected. Fix the correction message shape before this ships.',
      );
    }
    process.exitCode = 1;
  }
}

void main();
