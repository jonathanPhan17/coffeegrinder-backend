import { describe, expect, it } from 'vitest';
import { buildIndeedInput, normalizeIndeedItems } from './apify';

const row = {
  id: 'ind-1',
  positionName: 'Backend Engineer',
  company: 'Acme',
  description: 'Build things.',
  url: 'https://indeed.example/viewjob?jk=1',
  location: 'Remote',
};

describe('buildIndeedInput', () => {
  it('maps the search terms to the actor input with count as the cost cap', () => {
    expect(buildIndeedInput({ query: 'backend', location: 'NYC', limit: 25 })).toEqual({
      position: 'backend',
      location: 'NYC',
      maxItemsPerSearch: 25,
      country: 'US',
      saveOnlyUniqueItems: true,
    });
  });
});

describe('normalizeIndeedItems', () => {
  it('maps a clean row to a JobPosting using url (not externalApplyLink) and the stable id', () => {
    const [posting] = normalizeIndeedItems([row]);
    expect(posting).toEqual({
      sourceId: 'ind-1',
      source: 'apify',
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'Remote',
      description: 'Build things.',
      applyUrl: 'https://indeed.example/viewjob?jk=1',
    });
  });

  it('drops a row missing a required field but keeps the good ones (partial scrape is expected)', () => {
    const postings = normalizeIndeedItems([row, { ...row, id: 'ind-2', description: '' }]);
    expect(postings).toHaveLength(1);
    expect(postings[0].sourceId).toBe('ind-1');
  });

  it('throws when the dataset is not an array (actor schema drift → run-level error)', () => {
    expect(() => normalizeIndeedItems({ error: 'actor failed' })).toThrow();
  });

  it('returns an empty list for an empty dataset (a valid no-jobs-found result)', () => {
    expect(normalizeIndeedItems([])).toEqual([]);
  });
});
