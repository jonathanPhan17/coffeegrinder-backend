#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { ApiStack } from '../lib/api-stack';

const app = new App();
const config = loadConfig(app);

const data = new DataStack(app, `Coffeegrinder-Data-${config.envName}`, { config });

new ApiStack(app, `Coffeegrinder-Api-${config.envName}`, {
  config,
  table: data.table,
  bucket: data.bucket,
});
