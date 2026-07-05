import { describe, expect, it } from 'vitest';
import { resolveSource } from './resolve';

const posting = {
  title: 'Backend Engineer',
  company: 'Acme',
  applyUrl: 'https://acme.example/jobs/1',
  description: 'Build things.',
};

describe('resolveSource', () => {
  it('resolves to pasted when the body carries postings', () => {
    expect(resolveSource({ postings: [posting] })).toEqual({
      kind: 'pasted',
      postings: [posting],
    });
  });

  it('resolves to apify when there are no postings', () => {
    expect(resolveSource({})).toEqual({ kind: 'apify' });
  });
});
