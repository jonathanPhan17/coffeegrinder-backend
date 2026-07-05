import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Code, Function as LambdaFn, Runtime } from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { MatchingMachine } from './constructs/matching-machine';

// The state machine definition is a Fn::Join of literal ASL chunks with the lambda ARNs
// spliced in as tokens. Dropping the token objects and joining the literals is enough to
// assert on the graph's structure (the ARNs never sit inside the keys we check).
function joinedDefinition(template: Template): string {
  const machine = Object.values(
    template.findResources('AWS::StepFunctions::StateMachine'),
  )[0] as { Properties: { DefinitionString: { 'Fn::Join': [string, unknown[]] } } };
  const parts = machine.Properties.DefinitionString['Fn::Join'][1];
  return parts.filter((p): p is string => typeof p === 'string').join('');
}

const definition = ((): string => {
  const stack = new Stack(new App(), 'TestStack');
  const table = new TableV2(stack, 'Table', {
    partitionKey: { name: 'PK', type: AttributeType.STRING },
    sortKey: { name: 'SK', type: AttributeType.STRING },
  });
  const lambda = (id: string) =>
    new LambdaFn(stack, id, {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async () => {};'),
    });
  new MatchingMachine(stack, 'Machine', {
    table,
    extractCriteria: lambda('Extract'),
    scorePosting: lambda('Score'),
    startActorRun: lambda('StartActor'),
    getActorStatus: lambda('GetActorStatus'),
    collectPostings: lambda('CollectPostings'),
  });
  return joinedDefinition(Template.fromStack(stack));
})();

describe('MatchingMachine', () => {
  it('fans out over postings with an inline Map capped at concurrency 5', () => {
    expect(definition).toContain('"Type":"Map"');
    expect(definition).toContain('"MaxConcurrency":5');
  });

  it('branches on source at the front: HasPostingIds skips Fetch for pasted runs', () => {
    expect(definition).toContain('"HasPostingIds"');
    expect(definition).toContain('"Type":"Choice"');
    // Pasted runs (postingIds already present) go straight to screening.
    expect(definition).toContain('"IsPresent":true');
  });

  it('runs the Apify Fetch stage as a Wait/poll loop with an attempts guard', () => {
    expect(definition).toContain('"SetFetching"');
    expect(definition).toContain('"StartActorRun"');
    expect(definition).toContain('"Type":"Wait"');
    expect(definition).toContain('"GetActorStatus"');
    expect(definition).toContain('"CollectPostings"');
    // The guard: too many polls trips to error rather than hanging.
    expect(definition).toContain('"NumericGreaterThanEquals":60');
  });

  it('never auto-retries StartActorRun (a retry would pay for a second actor run)', () => {
    // Only the throttle-retried Lambda tasks carry a Retry block; StartActorRun must not.
    const startIdx = definition.indexOf('"StartActorRun"');
    const waitIdx = definition.indexOf('"Type":"Wait"');
    expect(startIdx).toBeGreaterThan(-1);
    expect(definition.slice(startIdx, waitIdx)).not.toContain('"Retry"');
  });
});
