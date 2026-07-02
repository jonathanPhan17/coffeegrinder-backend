#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { ApiStack } from '../lib/api-stack';

const app = new App();
const config = loadConfig(app);

Tags.of(app).add('Project', 'coffeegrinder');
Tags.of(app).add('Environment', config.envName);
Tags.of(app).add('ManagedBy', 'cdk');

const data = new DataStack(app, `Coffeegrinder-Data-${config.envName}`, { config });
Tags.of(data).add('Component', 'data');

const api = new ApiStack(app, `Coffeegrinder-Api-${config.envName}`, {
  config,
  table: data.table,
  bucket: data.bucket,
});
Tags.of(api).add('Component', 'api');
