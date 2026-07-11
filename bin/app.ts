#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { ApiStack } from '../lib/api-stack';

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

const api = new ApiStack(app, `Coffeegrinder-Api-${config.envName}`, {
  config,
  env,
  table: data.table,
  bucket: data.bucket,
});
Tags.of(api).add('Component', 'api');
