// Thin Apify REST client (https://docs.apify.com/api/v2). No SDK — a few authenticated
// fetch calls. The state machine drives the lifecycle across states (start → poll → collect),
// so each call is a discrete, idempotent step rather than one long-lived request. A non-2xx
// response throws; the worker that called it lets the throw propagate to the machine's catch.

const API_BASE = 'https://api.apify.com/v2';

// Apify addresses a store actor as `user~name` in URLs, not `user/name`.
function actorPath(actorId: string): string {
  return actorId.replace('/', '~');
}

async function apifyGet<T>(path: string, token: string): Promise<T> {
  return request<T>('GET', path, token);
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Apify ${method} ${path} failed: ${res.status} ${detail.slice(0, 512)}`);
  }
  return (await res.json()) as T;
}

export interface StartedActorRun {
  apifyRunId: string;
  datasetId: string;
  status: string;
}

interface RunEnvelope {
  data: { id: string; defaultDatasetId: string; status: string };
}

// Start an actor run (async — returns immediately with the run id + its dataset id). We never
// use the run-sync-get-dataset-items endpoint: it holds the connection open for the whole
// scrape, which would pin this Lambda for minutes.
export async function startActorRun(
  actorId: string,
  input: Record<string, unknown>,
  token: string,
): Promise<StartedActorRun> {
  const { data } = await request<RunEnvelope>(
    'POST',
    `/acts/${actorPath(actorId)}/runs`,
    token,
    input,
  );
  return { apifyRunId: data.id, datasetId: data.defaultDatasetId, status: data.status };
}

export interface ActorRunStatus {
  status: string;
  datasetId: string;
}

export async function getActorRunStatus(
  apifyRunId: string,
  token: string,
): Promise<ActorRunStatus> {
  const { data } = await apifyGet<RunEnvelope>(`/actor-runs/${apifyRunId}`, token);
  return { status: data.status, datasetId: data.defaultDatasetId };
}

// The dataset items are the scraped rows. `clean=true` drops Apify's hidden/empty rows;
// normalization + validation happens in the caller (src/sources/apify.ts).
export async function getDatasetItems(datasetId: string, token: string): Promise<unknown> {
  return apifyGet<unknown>(`/datasets/${datasetId}/items?clean=true&format=json`, token);
}
