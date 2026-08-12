import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  Distribution,
  HttpVersion,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AaaaRecord, ARecord, RecordTarget, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';

export interface FrontendStackProps extends StackProps {
  config: EnvConfig;
  zone: IHostedZone;
  certificate: ICertificate;
}

/**
 * The public site: built frontend assets in a private S3 bucket, served by CloudFront
 * on the custom domain. Infra only — shipping the app is the frontend repo's deploy
 * script (build + s3 sync + invalidation), never a CDK deploy.
 */
export class FrontendStack extends Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { frontendDomain, isProd } = props.config;

    const siteBucket = new Bucket(this, 'SiteBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    const distribution = new Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        // OAC keeps the bucket fully private; CloudFront is the only allowed reader.
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      defaultRootObject: 'index.html',
      domainNames: [frontendDomain, `www.${frontendDomain}`],
      certificate: props.certificate,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      // NA + EU + Asia edges (Tokyo included) — widened from PRICE_CLASS_100 when the
      // first real user in Japan appeared; ALL adds only South America/Oceania edges.
      priceClass: PriceClass.PRICE_CLASS_200,
      httpVersion: HttpVersion.HTTP2_AND_3,
      // SPA fallback: React Router owns paths like /runs/<id>, which exist as no S3
      // object — deep links and refreshes must serve the shell instead of an error
      // (403 is S3's "no such key" through OAC). Never cached, so fixes ship instantly.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });

    const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
    new ARecord(this, 'ApexAlias', { zone: props.zone, target });
    new AaaaRecord(this, 'ApexAliasV6', { zone: props.zone, target });
    new ARecord(this, 'WwwAlias', { zone: props.zone, recordName: 'www', target });
    new AaaaRecord(this, 'WwwAliasV6', { zone: props.zone, recordName: 'www', target });

    new CfnOutput(this, 'SiteUrl', { value: `https://${frontendDomain}` });
    // The two values the frontend repo's deploy script targets.
    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}
