import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Caller identity (the Cognito sub); set by buildApp's auth hook before any route runs. */
    userId: string;
  }
}

// @fastify/aws-lambda decorates request.awsLambda at wrap time but ships no
// FastifyRequest augmentation, so the access is typed locally instead.
interface AwsLambdaDecoration {
  awsLambda?: { event?: APIGatewayProxyEventV2WithJWTAuthorizer };
}

/**
 * Production identity extractor: the `sub` claim of the JWT the HTTP API's user-pool
 * authorizer already verified at the gateway. Reads only the Lambda event the
 * @fastify/aws-lambda adapter decorates onto the request — never a header, so there is
 * no spoofable identity path in production. Returns undefined when no verified claim
 * exists (tests, local dev, direct invocation).
 */
export function lambdaJwtIdentity(request: FastifyRequest): string | undefined {
  const sub = (request as FastifyRequest & AwsLambdaDecoration).awsLambda?.event?.requestContext
    ?.authorizer?.jwt?.claims?.sub;
  // Claim values are typed string | number | boolean | string[] — only a non-empty
  // string names a user.
  return typeof sub === 'string' && sub !== '' ? sub : undefined;
}
