import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { AuthStack } from './auth-stack';
import type { EnvConfig } from './config';

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
    new AuthStack(new App(), `Coffeegrinder-Auth-${config.envName}`, {
      config,
      env: { account: '111111111111', region: 'us-west-1' },
    }),
  );

describe('AuthStack', () => {
  // User accounts are state: neither a stack delete nor a replacement-forcing change
  // may take the prod pool (and every account in it) along.
  it('retains and deletion-protects the user pool in prod', () => {
    const template = synth(makeConfig({ envName: 'prod', isProd: true }));
    template.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({ DeletionProtection: 'ACTIVE' }),
    });
  });

  it('destroys freely in dev', () => {
    const template = synth(makeConfig());
    template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Delete' });
  });

  it('signs users in by email', () => {
    const template = synth(makeConfig());
    template.hasResourceProperties(
      'AWS::Cognito::UserPool',
      Match.objectLike({ UsernameAttributes: ['email'] }),
    );
  });

  it('issues the SPA client no secret — browser code cannot keep one', () => {
    const template = synth(makeConfig());
    template.hasResourceProperties(
      'AWS::Cognito::UserPoolClient',
      Match.objectLike({ GenerateSecret: Match.absent() }),
    );
  });

  it('registers the site callback always and the localhost callback only outside prod', () => {
    const dev = synth(makeConfig());
    dev.hasResourceProperties(
      'AWS::Cognito::UserPoolClient',
      Match.objectLike({
        CallbackURLs: Match.arrayWith([
          'https://coffeegrinder.app/auth/callback',
          'http://localhost:5173/auth/callback',
        ]),
      }),
    );
    const prod = synth(makeConfig({ envName: 'prod', isProd: true }));
    prod.hasResourceProperties(
      'AWS::Cognito::UserPoolClient',
      Match.objectLike({
        CallbackURLs: [
          'https://coffeegrinder.app/auth/callback',
          'https://www.coffeegrinder.app/auth/callback',
        ],
      }),
    );
  });
});
