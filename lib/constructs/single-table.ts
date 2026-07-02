import type { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, Billing, ProjectionType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface SingleTableProps {
  removalPolicy: RemovalPolicy;
  pointInTimeRecovery: boolean;
}

// Single-table design (ARCHITECTURE.md §7): generic PK/SK hold every entity
// type. GSI1 is an overloaded index — each entity encodes its own access
// pattern into GSI1PK/GSI1SK (first use: the pipeline board, matches by status).
export class SingleTable extends Construct {
  readonly table: TableV2;

  constructor(scope: Construct, id: string, props: SingleTableProps) {
    super(scope, id);

    this.table = new TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: props.pointInTimeRecovery,
      },
      removalPolicy: props.removalPolicy,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
          projectionType: ProjectionType.ALL,
        },
      ],
    });
  }
}
