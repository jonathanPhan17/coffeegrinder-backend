import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { STATE_MACHINE_ARN } from './env';

export const sfn = new SFNClient({});

// The machine's front Choice (HasPostingIds) switches on which shape it receives: a pasted run
// arrives with postings already persisted (postingIds); an Apify run arrives with just the
// search terms and lets the Fetch stage produce postingIds.
export type RunPayload =
  | { userId: string; runId: string; postingIds: string[] }
  | { userId: string; runId: string; query: string; location?: string; limit: number };

// Starts a matching run. The execution name is the runId, so a given run maps to exactly
// one execution (a retried POST with the same id is rejected rather than duplicated).
export function startRunExecution(input: {
  name: string;
  payload: RunPayload;
}): Promise<unknown> {
  return sfn.send(
    new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: input.name,
      input: JSON.stringify(input.payload),
    }),
  );
}
