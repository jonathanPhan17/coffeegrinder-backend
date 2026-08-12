import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolDomain,
} from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';

export interface AuthStackProps extends StackProps {
  config: EnvConfig;
}

/**
 * Stateful layer: the Cognito user pool (open email+password signup), its hosted-UI
 * domain, and the no-secret SPA client. Exposed via props (never globals) for the
 * ApiStack's JWT authorizer to consume.
 */
export class AuthStack extends Stack {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.userPool = new UserPool(this, 'Users', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // User accounts are state: a stack replace must never delete them in prod.
      removalPolicy: config.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      deletionProtection: config.isProd,
    });

    const domain = new UserPoolDomain(this, 'HostedUi', {
      userPool: this.userPool,
      cognitoDomain: { domainPrefix: `coffeegrinder-${config.envName}` },
    });

    // The localhost callback enables local dev against the deployed pool; the prod
    // build omits it.
    const origins = [...config.siteOrigins, ...(config.isProd ? [] : ['http://localhost:5173'])];

    this.userPoolClient = new UserPoolClient(this, 'Spa', {
      userPool: this.userPool,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: origins.map((origin) => `${origin}/auth/callback`),
        logoutUrls: origins,
      },
      preventUserExistenceErrors: true,
    });

    // The values the frontend's VITE_ auth vars are filled from.
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'AuthDomain', { value: domain.baseUrl() });
  }
}
