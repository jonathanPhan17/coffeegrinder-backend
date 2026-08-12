/**
 * Single-table key helpers (ARCHITECTURE.md §7). One place to build PK/SK so
 * access patterns stay consistent as handlers are added.
 */
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
  /**
   * Run-quota counters (period-encoded, `used: number` attribute). The period lives in
   * the key -- `month` is `yyyy-mm`, `day` is `yyyy-mm-dd`, both UTC slices of an ISO
   * timestamp -- so counters never need a reset job or TTL (the table has none): a new
   * period simply starts a fresh item. Stale periods linger as ~13 tiny rows per user
   * per year -- accepted.
   */
  quotaMonth: (userId: string, month: string) => ({
    PK: `USER#${userId}`,
    SK: `QUOTA#${month}`,
  }),
  quotaDay: (day: string) => ({ PK: 'QUOTA#GLOBAL', SK: `DAY#${day}` }),
} as const;
