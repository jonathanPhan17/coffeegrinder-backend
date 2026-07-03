import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import {
  DefinitionBody,
  JsonPath,
  Pass,
  StateMachine,
  StateMachineType,
} from 'aws-cdk-lib/aws-stepfunctions';
import { DynamoAttributeValue, DynamoUpdateItem } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export interface MatchingMachineProps {
  table: TableV2;
}

// The matching pipeline as a Step Functions state machine. Branch (a) is a status-only
// skeleton: it walks a run through its lifecycle (fetching → screening → done, else
// → error) with DynamoDB UpdateItem service integrations — no Lambda. Branch (b) swaps
// the ProcessPostings placeholder for the real criteria → score → verify → persist work.
export class MatchingMachine extends Construct {
  readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: MatchingMachineProps) {
    super(scope, id);

    // Key mirrors keys.run(userId, runId) in src/shared/keys.ts: USER#<id> / RUN#<runId>.
    // resultPath is DISCARD so each write preserves { userId, runId } for the next state.
    const setStatus = (stateId: string, status: string): DynamoUpdateItem =>
      new DynamoUpdateItem(this, stateId, {
        table: props.table,
        key: {
          PK: DynamoAttributeValue.fromString(
            JsonPath.format('USER#{}', JsonPath.stringAt('$.userId')),
          ),
          SK: DynamoAttributeValue.fromString(
            JsonPath.format('RUN#{}', JsonPath.stringAt('$.runId')),
          ),
        },
        updateExpression: 'SET #status = :status',
        expressionAttributeNames: { '#status': 'status' },
        expressionAttributeValues: { ':status': DynamoAttributeValue.fromString(status) },
        resultPath: JsonPath.DISCARD,
      });

    const setError = setStatus('SetError', 'error');
    const setFetching = setStatus('SetFetching', 'fetching');
    const setScreening = setStatus('SetScreening', 'screening');
    const setDone = setStatus('SetDone', 'done');
    const processPostings = new Pass(this, 'ProcessPostings', {
      comment: 'branch (b): extract criteria → score (Bedrock) → verify (code) → persist match',
    });

    for (const state of [setFetching, setScreening, setDone]) {
      state.addCatch(setError, { resultPath: '$.error' });
    }

    const definition = setFetching.next(setScreening).next(processPostings).next(setDone);

    this.stateMachine = new StateMachine(this, 'Resource', {
      definitionBody: DefinitionBody.fromChainable(definition),
      stateMachineType: StateMachineType.STANDARD,
    });

    // Explicit least-privilege write grant to the machine role (the UpdateItem states).
    props.table.grantWriteData(this.stateMachine);
  }
}
