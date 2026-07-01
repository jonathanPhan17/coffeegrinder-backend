// Single-table key helpers (ARCHITECTURE.md §7). One place to build PK/SK so
// access patterns stay consistent as handlers are added.
export const keys = {
  userProfile: (userId: string) => ({ PK: `USER#${userId}`, SK: 'PROFILE' }),
  run: (userId: string, runId: string) => ({ PK: `USER#${userId}`, SK: `RUN#${runId}` }),
  posting: (runId: string, postingId: string) => ({
    PK: `RUN#${runId}`,
    SK: `POSTING#${postingId}`,
  }),
  match: (runId: string, postingId: string) => ({
    PK: `RUN#${runId}`,
    SK: `MATCH#${postingId}`,
  }),
  evidence: (matchId: string, criterion: string) => ({
    PK: `MATCH#${matchId}`,
    SK: `EVIDENCE#${criterion}`,
  }),
  coverLetter: (matchId: string, version: number) => ({
    PK: `MATCH#${matchId}`,
    SK: `LETTER#${version}`,
  }),
} as const;
