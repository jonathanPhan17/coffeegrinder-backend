#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { AuthStack } from '../lib/auth-stack';
import { ApiStack } from '../lib/api-stack';
import { DnsStack } from '../lib/dns-stack';
import { FrontendCertStack } from '../lib/frontend-cert-stack';
import { FrontendStack } from '../lib/frontend-stack';

const app = new App();
const config = loadConfig(app);

// Pin every stack to the account/region of the deploying credentials — templates stay
// environment-specific (and lookups possible) instead of anonymous.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

Tags.of(app).add('Project', 'coffeegrinder');
Tags.of(app).add('Environment', config.envName);
Tags.of(app).add('ManagedBy', 'cdk');

const data = new DataStack(app, `Coffeegrinder-Data-${config.envName}`, { config, env });
Tags.of(data).add('Component', 'data');

const auth = new AuthStack(app, `Coffeegrinder-Auth-${config.envName}`, { config, env });
Tags.of(auth).add('Component', 'auth');

const api = new ApiStack(app, `Coffeegrinder-Api-${config.envName}`, {
  config,
  env,
  table: data.table,
  bucket: data.bucket,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
});
Tags.of(api).add('Component', 'api');

// Frontend hosting trio. CloudFront only accepts us-east-1 certificates, so the cert
// stack alone pins that region and crossRegionReferences bridges the zone/cert handoffs
// (SSM-backed under the hood) — it must be set on every stack in the chain.
const dns = new DnsStack(app, `Coffeegrinder-Dns-${config.envName}`, {
  config,
  env,
  crossRegionReferences: true,
});
Tags.of(dns).add('Component', 'frontend');

const cert = new FrontendCertStack(app, `Coffeegrinder-FrontendCert-${config.envName}`, {
  config,
  env: { account: env.account, region: 'us-east-1' },
  zone: dns.zone,
  crossRegionReferences: true,
});
Tags.of(cert).add('Component', 'frontend');

const frontend = new FrontendStack(app, `Coffeegrinder-Frontend-${config.envName}`, {
  config,
  env,
  zone: dns.zone,
  certificate: cert.certificate,
  crossRegionReferences: true,
});
Tags.of(frontend).add('Component', 'frontend');
