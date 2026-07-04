import { Duration } from 'aws-cdk-lib';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import {
  DefinitionBody,
  JsonPath,
  Map as SfnMap,
  StateMachine,
  StateMachineType,
  type TaskStateBase,
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
  scorePosting: IFunction;
}

// Throttling errors worth retrying — the dominant failure mode once the per-posting chain
// fans out across the Map. Complements LambdaInvoke's built-in retrier (which already covers
// Lambda.ServiceException/SdkClientException etc.): this adds the Bedrock throttle
// (ThrottlingException) and the Lambda invoke throttle it omits.
const THROTTLE_ERRORS = ['ThrottlingException', 'Lambda.TooManyRequestsException'];

// The matching pipeline as a Step Functions state machine. Run-status transitions are
// DynamoDB UpdateItem service integrations (no Lambda); the per-posting work (extract
// criteria → score → verify → persist) runs as Lambda tasks inside an inline Map over the
// run's postingIds, capped at maxConcurrency 5. An empty postingIds array (a query-only
// skeleton run) runs zero iterations and falls straight through to SetDone. A single
// posting's failure is caught, counted on the run's `failed`, and skipped so it can't sink
// the whole run; each success bumps the run's `screened` for live progress.
// Inline Map (not the Distributed Map named in §9.5) is the right tool for N ≤ 50 — see
// ARCHITECTURE.md §9 phase 5 for the deviation and the swap trigger.
export class MatchingMachine extends Construct {
  readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: MatchingMachineProps) {
    super(scope, id);

    // Key mirrors keys.run(userId, runId) in src/shared/keys.ts: USER#<id> / RUN#<runId>.
    // A fresh descriptor per state; resultPath DISCARD so each write preserves
    // { userId, runId, ... } for the states downstream.
    const runKey = () => ({
      PK: DynamoAttributeValue.fromString(
        JsonPath.format('USER#{}', JsonPath.stringAt('$.userId')),
      ),
      SK: DynamoAttributeValue.fromString(
        JsonPath.format('RUN#{}', JsonPath.stringAt('$.runId')),
      ),
    });

    const setStatus = (stateId: string, status: string): DynamoUpdateItem =>
      new DynamoUpdateItem(this, stateId, {
        table: props.table,
        key: runKey(),
        updateExpression: 'SET #status = :status',
        expressionAttributeNames: { '#status': 'status' },
        expressionAttributeValues: { ':status': DynamoAttributeValue.fromString(status) },
        resultPath: JsonPath.DISCARD,
      });

    // Atomic per-run counter bump (ADD starts from 0 when the attribute is absent), so
    // parallel Map iterations increment without a read-modify-write race.
    const addToRunCounter = (stateId: string, attr: string): DynamoUpdateItem =>
      new DynamoUpdateItem(this, stateId, {
        table: props.table,
        key: runKey(),
        updateExpression: `ADD #${attr} :one`,
        expressionAttributeNames: { [`#${attr}`]: attr },
        expressionAttributeValues: { ':one': DynamoAttributeValue.fromNumber(1) },
        resultPath: JsonPath.DISCARD,
      });

    const setError = setStatus('SetError', 'error');
    const setFetching = setStatus('SetFetching', 'fetching');
    const setScreening = setStatus('SetScreening', 'screening');
    const setDone = setStatus('SetDone', 'done');

    const incrementScreened = addToRunCounter('IncrementScreened', 'screened');
    const recordFailure = addToRunCounter('RecordFailure', 'failed');

    const extractCriteria = new LambdaInvoke(this, 'ExtractCriteria', {
      lambdaFunction: props.extractCriteria,
      resultPath: JsonPath.DISCARD,
    });
    const scorePosting = new LambdaInvoke(this, 'ScorePosting', {
      lambdaFunction: props.scorePosting,
      resultPath: JsonPath.DISCARD,
    });

    // Retry transient throttles; on final failure, tolerate the one posting — record it on
    // the run's `failed` counter and let the Map iteration finish, so a single bad JD can't
    // sink the whole run (a done-with-zero-matches outcome stays explainable via `failed`).
    const lambdaTasks: TaskStateBase[] = [extractCriteria, scorePosting];
    for (const task of lambdaTasks) {
      task.addRetry({
        errors: THROTTLE_ERRORS,
        maxAttempts: 2,
        interval: Duration.seconds(2),
        backoffRate: 2,
      });
      task.addCatch(recordFailure, { resultPath: '$.error' });
    }

    // The whole-run lifecycle writes still fail the run outright.
    for (const state of [setFetching, setScreening, setDone]) {
      state.addCatch(setError, { resultPath: '$.error' });
    }

    const perPosting = extractCriteria.next(scorePosting).next(incrementScreened);

    // One iteration per postingId; empty array → zero iterations → SetDone.
    const mapPostings = new SfnMap(this, 'MapPostings', {
      itemsPath: '$.postingIds',
      itemSelector: {
        userId: JsonPath.stringAt('$.userId'),
        runId: JsonPath.stringAt('$.runId'),
        postingId: JsonPath.stringAt('$$.Map.Item.Value'),
      },
      maxConcurrency: 5,
      resultPath: JsonPath.DISCARD,
    });
    mapPostings.itemProcessor(perPosting);
    mapPostings.addCatch(setError, { resultPath: '$.error' });

    const definition = setFetching.next(setScreening).next(mapPostings).next(setDone);

    this.stateMachine = new StateMachine(this, 'Resource', {
      definitionBody: DefinitionBody.fromChainable(definition),
      stateMachineType: StateMachineType.STANDARD,
    });

    // Explicit least-privilege write grant for the UpdateItem states (status + counters);
    // each LambdaInvoke grants its own invoke permission to the machine role.
    props.table.grantWriteData(this.stateMachine);
  }
}
