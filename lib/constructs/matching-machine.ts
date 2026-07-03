import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import {
  Choice,
  Condition,
  DefinitionBody,
  JsonPath,
  StateMachine,
  StateMachineType,
} from 'aws-cdk-lib/aws-stepfunctions';
import {
  DynamoAttributeValue,
  DynamoUpdateItem,
  LambdaInvoke,
} from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export interface MatchingMachineProps {
  table: TableV2;
  extractCriteria: IFunction;
}

// The matching pipeline as a Step Functions state machine. Run-status transitions are
// DynamoDB UpdateItem service integrations (no Lambda); the per-posting work runs as
// Lambda tasks between SetScreening and SetDone. A run carrying a postingId is processed
// (b1: criteria extraction; b2 adds score → verify → persist); a query-only skeleton run
// just walks the status lifecycle. §9.5 wraps the per-posting chain in a Distributed Map
// over the run's postings.
export class MatchingMachine extends Construct {
  readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: MatchingMachineProps) {
    super(scope, id);

    // Key mirrors keys.run(userId, runId) in src/shared/keys.ts: USER#<id> / RUN#<runId>.
    // resultPath DISCARD so each write preserves { userId, runId, postingId } downstream.
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

    const extractCriteria = new LambdaInvoke(this, 'ExtractCriteria', {
      lambdaFunction: props.extractCriteria,
      resultPath: JsonPath.DISCARD,
    });

    for (const state of [setFetching, setScreening, setDone, extractCriteria]) {
      state.addCatch(setError, { resultPath: '$.error' });
    }

    // Only score a run that carries a pasted posting; a query-only skeleton run finishes.
    const processPosting = new Choice(this, 'HasPosting')
      .when(Condition.isPresent('$.postingId'), extractCriteria.next(setDone))
      .otherwise(setDone);

    const definition = setFetching.next(setScreening).next(processPosting);

    this.stateMachine = new StateMachine(this, 'Resource', {
      definitionBody: DefinitionBody.fromChainable(definition),
      stateMachineType: StateMachineType.STANDARD,
    });

    // Explicit least-privilege write grant for the UpdateItem states; LambdaInvoke grants
    // its own invoke permission to the machine role.
    props.table.grantWriteData(this.stateMachine);
  }
}
