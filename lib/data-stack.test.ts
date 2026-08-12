import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import type { EnvConfig } from './config';
import { DataStack } from './data-stack';

const makeConfig = (overrides: Partial<EnvConfig> = {}): EnvConfig => ({
  envName: 'dev',
  isProd: false,
  allowedOrigins: ['http://localhost:5173'],
  siteOrigins: ['https://coffeegrinder.app', 'https://www.coffeegrinder.app'],
  bedrockModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  bedrockFastModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  apifyTokenParam: '/coffeegrinder/apify-token',
  apifyActorId: 'misceres/indeed-scraper',
  frontendDomain: 'coffeegrinder.app',
  ...overrides,
});

const synth = (config: EnvConfig): Template =>
  Template.fromStack(
    new DataStack(new App(), `Coffeegrinder-Data-${config.envName}`, {
      config,
      env: { account: '111111111111', region: 'us-west-1' },
    }),
  );

describe('DataStack', () => {
  // The single most important infra invariant: a prod stack delete (or a replacement-forcing
  // change) must never take the table or the resumes with it.
  it('retains the table and bucket in prod', () => {
    const template = synth(makeConfig({ envName: 'prod', isProd: true }));
    template.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    // No auto-delete handler in prod — emptying the bucket must stay a deliberate manual act.
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  it('destroys freely in dev', () => {
    const template = synth(makeConfig());
    template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' });
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('keeps point-in-time recovery enabled on the table', () => {
    const template = synth(makeConfig({ envName: 'prod', isProd: true }));
    template.hasResourceProperties(
      'AWS::DynamoDB::GlobalTable',
      Match.objectLike({
        Replicas: Match.arrayWith([
          Match.objectLike({
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          }),
        ]),
      }),
    );
  });
});
