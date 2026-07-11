import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';
import { SingleTable } from './constructs/single-table';
import { ResumeBucket } from './constructs/resume-bucket';

export interface DataStackProps extends StackProps {
  config: EnvConfig;
}

/**
 * Stateful layer: single-table DynamoDB + resume S3 bucket. Exposed via props
 * (never globals) for the ApiStack to consume.
 */
export class DataStack extends Stack {
  readonly table: TableV2;
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const removalPolicy = props.config.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const screening = new SingleTable(this, 'Screening', {
      removalPolicy,
      pointInTimeRecovery: true,
    });
    this.table = screening.table;

    const resumes = new ResumeBucket(this, 'Resumes', {
      allowedOrigins: props.config.allowedOrigins,
      removalPolicy,
      autoDeleteObjects: !props.config.isProd,
    });
    this.bucket = resumes.bucket;

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
  }
}
