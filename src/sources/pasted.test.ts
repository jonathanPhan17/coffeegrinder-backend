import { describe, expect, it } from 'vitest';
import { PastedSource } from './pasted';

const posting = {
  title: 'Backend Engineer',
  company: 'Acme',
  applyUrl: 'https://acme.example/jobs/1',
  description: 'Build things.',
};

describe('PastedSource', () => {
  it('normalizes pasted input into a JobPosting tagged "pasted" with an id', async () => {
    const [result] = await new PastedSource([posting]).fetch({ query: 'backend', limit: 1 });

    expect(result.source).toBe('pasted');
    expect(result.title).toBe('Backend Engineer');
    expect(result.applyUrl).toBe(posting.applyUrl);
    expect(result.sourceId).toBeTruthy();
  });

  it('respects the limit', async () => {
    const results = await new PastedSource([posting, posting, posting]).fetch({
      query: 'x',
      limit: 2,
    });

    expect(results).toHaveLength(2);
  });

  it('returns nothing when constructed empty', async () => {
    const results = await new PastedSource([]).fetch({ query: 'x', limit: 5 });

    expect(results).toHaveLength(0);
  });
});
