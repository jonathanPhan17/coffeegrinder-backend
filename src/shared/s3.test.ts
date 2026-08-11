import { beforeAll, describe, expect, it } from 'vitest';
import { ENV_KEYS } from './env-keys';

// Signing happens fully offline, so fake credentials produce a real, inspectable URL.
// Env must be in place before ./s3 (and ./env) load, hence the dynamic import.
let presignUpload: (typeof import('./s3'))['presignUpload'];

beforeAll(async () => {
  process.env[ENV_KEYS.bucketName] = 'test-bucket';
  process.env.AWS_REGION = 'us-west-1';
  process.env.AWS_ACCESS_KEY_ID = 'AKIAFAKEFAKEFAKEFAKE';
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret';
  ({ presignUpload } = await import('./s3'));
});

describe('presignUpload', () => {
  it('signs content-type and content-length so S3 enforces both', async () => {
    const url = new URL(await presignUpload('resumes/me/x.pdf', 'application/pdf', 12345, 300));

    const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    expect(signed).toContain('content-type');
    expect(signed).toContain('content-length');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.hostname).toContain('test-bucket');
    expect(url.pathname).toBe('/resumes/me/x.pdf');
  });

  it('keeps SDK integrity checksums out of the URL', async () => {
    const url = new URL(await presignUpload('resumes/me/x.pdf', 'application/pdf', 12345, 300));

    // SDK >= 3.729 defaults would bake x-amz-checksum-crc32=AAAAAA== (the CRC32 of an
    // EMPTY body) into the signed query — S3 would then reject every real upload.
    const checksumParams = [...url.searchParams.keys()].filter((k) =>
      k.toLowerCase().includes('checksum'),
    );
    expect(checksumParams).toEqual([]);
  });
});
