import { Duration } from 'aws-cdk-lib';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import {
  Choice,
  Condition,
  DefinitionBody,
  JsonPath,
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
// fans out under a Distributed Map (§9.5). Complements LambdaInvoke's built-in retrier
// (which already covers Lambda.ServiceException/SdkClientException etc.): this adds the
// Bedrock throttle (ThrottlingException) and the Lambda invoke throttle it omits.
const THROTTLE_ERRORS = ['ThrottlingException', 'Lambda.TooManyRequestsException'];

// The matching pipeline as a Step Functions state machine. Run-status transitions are
// DynamoDB UpdateItem service integrations (no Lambda); the per-posting work runs as Lambda
// tasks between SetScreening and SetDone. A run carrying a postingId is processed (extract
// criteria → score → verify → persist); a query-only skeleton run just walks the lifecycle.
// §9.5 wraps the per-posting chain in a Distributed Map over the run's postings.
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
    const scorePosting = new LambdaInvoke(this, 'ScorePosting', {
      lambdaFunction: props.scorePosting,
      resultPath: JsonPath.DISCARD,
    });

    // Retry transient failures before falling through to the Catch.
    const lambdaTasks: TaskStateBase[] = [extractCriteria, scorePosting];
    for (const task of lambdaTasks) {
      task.addRetry({
        errors: THROTTLE_ERRORS,
        maxAttempts: 2,
        interval: Duration.seconds(2),
        backoffRate: 2,
      });
    }
    for (const state of [setFetching, setScreening, setDone, ...lambdaTasks]) {
      state.addCatch(setError, { resultPath: '$.error' });
    }

    // Only score a run that carries a pasted posting; a query-only skeleton run finishes.
    const processPosting = new Choice(this, 'HasPosting')
      .when(
        Condition.isPresent('$.postingId'),
        extractCriteria.next(scorePosting).next(setDone),
      )
      .otherwise(setDone);

    const definition = setFetching.next(setScreening).next(processPosting);

    this.stateMachine = new StateMachine(this, 'Resource', {
      definitionBody: DefinitionBody.fromChainable(definition),
      stateMachineType: StateMachineType.STANDARD,
    });

    // Explicit least-privilege write grant for the UpdateItem states; each LambdaInvoke
    // grants its own invoke permission to the machine role.
    props.table.grantWriteData(this.stateMachine);
  }
}
