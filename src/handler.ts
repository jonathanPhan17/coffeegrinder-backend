import awsLambdaFastify from '@fastify/aws-lambda';
import { buildApp } from './app';

export const handler = awsLambdaFastify(buildApp());
