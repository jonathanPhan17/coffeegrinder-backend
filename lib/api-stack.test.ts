import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';
import { ApiStack } from './api-stack';
import type { EnvConfig } from './config';

const ENV = { account: '111111111111', region: 'us-west-1' };

const SONNET_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const HAIKU_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const makeConfig = (bedrockModelId: string, bedrockFastModelId: string): EnvConfig => ({
  envName: 'dev',
  isProd: false,
  allowedOrigins: ['http://localhost:5173'],
  bedrockModelId,
  bedrockFastModelId,
  apifyTokenParam: '/coffeegrinder/apify-token',
  apifyActorId: 'misceres/indeed-scraper',
  frontendDomain: 'coffeegrinder.app',
});

function synthApi(bedrockModelId: string, bedrockFastModelId = ''): Template {
  // Skip esbuild bundling — the assertions only need the resource graph, and bundling
  // every NodejsFunction would dominate the suite's runtime.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const support = new Stack(app, 'Support', { env: ENV });
  const table = new TableV2(support, 'Table', {
    partitionKey: { name: 'PK', type: AttributeType.STRING },
    sortKey: { name: 'SK', type: AttributeType.STRING },
  });
  const bucket = new Bucket(support, 'Bucket');
  const stack = new ApiStack(app, 'Api', {
    env: ENV,
    config: makeConfig(bedrockModelId, bedrockFastModelId),
    table,
    bucket,
  });
  return Template.fromStack(stack);
}

interface StatementShape {
  Action: string | string[];
  Resource?: unknown;
  Condition?: Record<string, unknown>;
}

function allStatements(template: Template): StatementShape[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as StatementShape[],
  );
}

// Resolve each Lambda's role so grants can be asserted per-function; functions are
// identified by their environment variables (entry paths never reach the template).
function rolesWithEnv(
  template: Template,
  predicate: (env: Record<string, unknown>) => boolean,
): string[] {
  return Object.values(template.findResources('AWS::Lambda::Function'))
    .filter((fn) =>
      predicate((fn.Properties.Environment?.Variables ?? {}) as Record<string, unknown>),
    )
    .map((fn) => (fn.Properties.Role as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0]);
}

function statementsOfRole(template: Template, roleLogicalId: string): StatementShape[] {
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((policy) =>
      (policy.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === roleLogicalId),
    )
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement as StatementShape[]);
}

function actionsOfRole(template: Template, roleLogicalId: string): string[] {
  return statementsOfRole(template, roleLogicalId).flatMap((statement) => [statement.Action].flat());
}

function bedrockInvokesOfRole(template: Template, roleLogicalId: string): StatementShape[] {
  return statementsOfRole(template, roleLogicalId).filter((s) =>
    [s.Action].flat().includes('bedrock:InvokeModel'),
  );
}

const template = synthApi(SONNET_ID, HAIKU_ID);

describe('ApiStack IAM posture', () => {
  it('scopes every kms:Decrypt to SSM via the ViaService condition, never a bare wildcard', () => {
    const decrypts = allStatements(template).filter((s) =>
      [s.Action].flat().includes('kms:Decrypt'),
    );
    expect(decrypts.length).toBeGreaterThan(0);
    for (const statement of decrypts) {
      expect(statement.Condition).toEqual({
        StringEquals: { 'kms:ViaService': 'ssm.us-west-1.amazonaws.com' },
      });
    }
  });

  it('grants GetActorStatus no table access at all (it only polls Apify)', () => {
    const roles = rolesWithEnv(
      template,
      (env) => 'APIFY_TOKEN_PARAM' in env && !('TABLE_NAME' in env),
    );
    expect(roles).toHaveLength(1);
    const dynamoActions = actionsOfRole(template, roles[0]).filter((a) =>
      a.startsWith('dynamodb:'),
    );
    expect(dynamoActions).toEqual([]);
  });

  it('never grants an Apify worker table READ access (write-only where needed)', () => {
    const roles = rolesWithEnv(template, (env) => 'APIFY_TOKEN_PARAM' in env);
    expect(roles).toHaveLength(3); // StartActorRun, GetActorStatus, CollectPostings
    for (const role of roles) {
      const actions = actionsOfRole(template, role);
      expect(actions).not.toContain('dynamodb:GetItem');
      expect(actions).not.toContain('dynamodb:Query');
      expect(actions).not.toContain('dynamodb:Scan');
    }
  });

  it('grants the score worker the standard model only — never the fast one', () => {
    // Scoring must stay on the full-strength model. Note the guard's limit: ScorePosting
    // carries no fast id, so a tier flip in score-match.ts alone falls back to the standard
    // model at runtime and never trips this grant — a scoring swap must come through config
    // (see the grant comment in api-stack.ts). This test pins the grant so that swap is a
    // visible template change.
    const roles = rolesWithEnv(
      template,
      (env) => 'BEDROCK_MODEL_ID' in env && !('BEDROCK_FAST_MODEL_ID' in env),
    );
    expect(roles).toHaveLength(1); // ScorePosting
    const invokes = bedrockInvokesOfRole(template, roles[0]);
    expect(invokes.length).toBeGreaterThan(0);
    for (const statement of invokes) {
      // CDK emits a single resource as a scalar, not a one-element array — flatten first.
      expect([statement.Resource].flat()).toEqual([
        `arn:aws:bedrock:us-west-1:111111111111:inference-profile/${SONNET_ID}`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      ]);
    }
  });

  it('grants the extraction workers the fast model only — never the standard one', () => {
    const roles = rolesWithEnv(template, (env) => 'BEDROCK_FAST_MODEL_ID' in env);
    expect(roles).toHaveLength(2); // ParseResume, ExtractCriteria
    for (const role of roles) {
      const invokes = bedrockInvokesOfRole(template, role);
      expect(invokes.length).toBeGreaterThan(0);
      for (const statement of invokes) {
        expect([statement.Resource].flat()).toEqual([
          `arn:aws:bedrock:us-west-1:111111111111:inference-profile/${HAIKU_ID}`,
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
        ]);
      }
    }
  });

  it('grants every AI worker the standard model when no fast model is configured', () => {
    const noSplit = synthApi(SONNET_ID);
    // No worker carries the fast env var, and every Bedrock grant is the standard model —
    // an env without the split behaves exactly as before it existed.
    expect(rolesWithEnv(noSplit, (env) => 'BEDROCK_FAST_MODEL_ID' in env)).toHaveLength(0);
    const invokes = allStatements(noSplit).filter((s) =>
      [s.Action].flat().includes('bedrock:InvokeModel'),
    );
    expect(invokes.length).toBeGreaterThan(0);
    for (const statement of invokes) {
      expect([statement.Resource].flat()).toEqual([
        `arn:aws:bedrock:us-west-1:111111111111:inference-profile/${SONNET_ID}`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      ]);
    }
  });

  it('scopes a bare foundation-model id to its single regional ARN', () => {
    const bare = synthApi('anthropic.claude-sonnet-4-5-20250929-v1:0');
    const invokes = allStatements(bare).filter((s) =>
      [s.Action].flat().includes('bedrock:InvokeModel'),
    );
    expect(invokes.length).toBeGreaterThan(0);
    for (const statement of invokes) {
      expect([statement.Resource].flat()).toEqual([
        'arn:aws:bedrock:us-west-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      ]);
    }
  });
});

describe('ApiStack event wiring', () => {
  it('triggers the parse worker only for objects under resumes/', () => {
    template.hasResourceProperties(
      'AWS::Events::Rule',
      Match.objectLike({
        EventPattern: Match.objectLike({
          source: ['aws.s3'],
          'detail-type': ['Object Created'],
          detail: Match.objectLike({
            object: { key: [{ prefix: 'resumes/' }] },
          }),
        }),
      }),
    );
  });
});
