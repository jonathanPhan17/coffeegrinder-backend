import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

// Module-scope memo so a warm Lambda container fetches each SecureString once, not per
// invocation. Keyed by name; a failed fetch is evicted so the next call retries rather than
// caching the rejection.
const cache = new Map<string, Promise<string>>();

export function getSecureParam(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;

  const pending = ssm
    .send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    .then((res) => {
      const value = res.Parameter?.Value;
      if (!value) throw new Error(`SSM parameter ${name} has no value`);
      return value;
    })
    .catch((err) => {
      cache.delete(name);
      throw err;
    });

  cache.set(name, pending);
  return pending;
}
