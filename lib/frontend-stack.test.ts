import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import type { EnvConfig } from './config';
import { DnsStack } from './dns-stack';
import { FrontendCertStack } from './frontend-cert-stack';
import { FrontendStack } from './frontend-stack';

const ACCOUNT = '111111111111';

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

// The trio synths together: the site stack consumes the zone and the us-east-1
// certificate exactly the way bin/app.ts wires them.
function synthSite(config: EnvConfig): Template {
  const app = new App();
  const dns = new DnsStack(app, 'Dns', {
    config,
    env: { account: ACCOUNT, region: 'us-west-1' },
    crossRegionReferences: true,
  });
  const cert = new FrontendCertStack(app, 'Cert', {
    config,
    env: { account: ACCOUNT, region: 'us-east-1' },
    zone: dns.zone,
    crossRegionReferences: true,
  });
  const site = new FrontendStack(app, 'Frontend', {
    config,
    env: { account: ACCOUNT, region: 'us-west-1' },
    zone: dns.zone,
    certificate: cert.certificate,
    crossRegionReferences: true,
  });
  return Template.fromStack(site);
}

describe('FrontendStack', () => {
  it('serves both domain names and falls back to index.html for router paths', () => {
    const template = synthSite(makeConfig());
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['coffeegrinder.app', 'www.coffeegrinder.app'],
        DefaultRootObject: 'index.html',
        // Both S3 "not found" flavors must serve the SPA shell, uncached, as 200s.
        CustomErrorResponses: [403, 404].map((code) => ({
          ErrorCode: code,
          ResponseCode: 200,
          ResponsePagePath: '/index.html',
          ErrorCachingMinTTL: 0,
        })),
      }),
    });
  });

  it('keeps the site bucket private — CloudFront is the only reader', () => {
    const template = synthSite(makeConfig());
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      }),
    });
    // No S3 website hosting — the distribution reads objects via OAC, not a website endpoint.
    template.hasResourceProperties('AWS::S3::Bucket', {
      WebsiteConfiguration: Match.absent(),
    });
  });

  it('aliases apex and www, over IPv4 and IPv6, at the distribution', () => {
    const template = synthSite(makeConfig());
    template.resourceCountIs('AWS::Route53::RecordSet', 4);
    for (const name of ['coffeegrinder.app.', 'www.coffeegrinder.app.']) {
      for (const type of ['A', 'AAAA']) {
        template.hasResourceProperties('AWS::Route53::RecordSet', {
          Name: name,
          Type: type,
          AliasTarget: Match.anyValue(),
        });
      }
    }
  });

  it('retains the site bucket in prod', () => {
    const template = synthSite(makeConfig({ envName: 'prod', isProd: true }));
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });
});
