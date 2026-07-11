import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';
import { ApiStack } from './api-stack';
import type { EnvConfig } from './config';

const ENV = { account: '111111111111', region: 'us-west-1' };

const makeConfig = (bedrockModelId: string): EnvConfig => ({
  envName: 'dev',
  isProd: false,
  allowedOrigins: ['http://localhost:5173'],
  bedrockModelId,
  apifyTokenParam: '/coffeegrinder/apify-token',
  apifyActorId: 'misceres/indeed-scraper',
});

function synthApi(bedrockModelId: string): Template {
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
    config: makeConfig(bedrockModelId),
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

function actionsOfRole(template: Template, roleLogicalId: string): string[] {
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((policy) =>
      (policy.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === roleLogicalId),
    )
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement as StatementShape[])
    .flatMap((statement) => [statement.Action].flat());
}

const template = synthApi('us.anthropic.claude-sonnet-4-5-20250929-v1:0');

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

  it('scopes bedrock:InvokeModel to the inference profile plus its foundation model', () => {
    const invokes = allStatements(template).filter((s) =>
      [s.Action].flat().includes('bedrock:InvokeModel'),
    );
    expect(invokes.length).toBeGreaterThan(0);
    for (const statement of invokes) {
      // CDK emits a single resource as a scalar, not a one-element array — flatten first.
      expect([statement.Resource].flat()).toEqual([
        'arn:aws:bedrock:us-west-1:111111111111:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0',
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
