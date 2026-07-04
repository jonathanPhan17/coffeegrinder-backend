import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { STATE_MACHINE_ARN } from './env';

export const sfn = new SFNClient({});

// Starts a matching run. The execution name is the runId, so a given run maps to exactly
// one execution (a retried POST with the same id is rejected rather than duplicated).
export function startRunExecution(input: {
  name: string;
  payload: { userId: string; runId: string; postingIds: string[] };
}): Promise<unknown> {
  return sfn.send(
    new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: input.name,
      input: JSON.stringify(input.payload),
    }),
  );
}
