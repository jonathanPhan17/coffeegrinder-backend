import type { RemovalPolicy } from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface ResumeBucketProps {
  /** Browser origins allowed to presign-upload; CORS is omitted when empty. */
  allowedOrigins: string[];
  removalPolicy: RemovalPolicy;
  autoDeleteObjects: boolean;
}

// Private resume bucket. CORS is scoped to the frontend origin so the browser
// can PUT directly against a presigned URL (upload flow, added later).
export class ResumeBucket extends Construct {
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: ResumeBucketProps) {
    super(scope, id);

    this.bucket = new Bucket(this, 'Bucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Emit ObjectCreated events to EventBridge so a worker in another stack can
      // subscribe without a bucket->Lambda reference (which would cycle the stacks).
      eventBridgeEnabled: true,
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: props.autoDeleteObjects,
      cors: props.allowedOrigins.length
        ? [
            {
              allowedMethods: [HttpMethods.PUT, HttpMethods.GET, HttpMethods.HEAD],
              allowedOrigins: props.allowedOrigins,
              allowedHeaders: ['*'],
              exposedHeaders: ['ETag'],
              maxAge: 3000,
            },
          ]
        : undefined,
    });
  }
}
