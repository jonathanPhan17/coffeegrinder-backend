import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';

export interface DataStackProps extends StackProps {
  config: EnvConfig;
}

// Stateful layer: single-table DynamoDB + resume S3 bucket. GSI1, PITR, CORS
// and outputs are added in feat/data-stack.
export class DataStack extends Stack {
  readonly table: TableV2;
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const removalPolicy = props.config.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.table = new TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      removalPolicy,
    });

    this.bucket = new Bucket(this, 'ResumeBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !props.config.isProd,
    });
  }
}
