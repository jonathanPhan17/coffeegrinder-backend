import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { MAX_RESUME_SIZE_BYTES, UPLOAD_URL_TTL_SECONDS } from '../shared/constants';
import { presignUpload } from '../shared/s3';

vi.mock('../shared/s3', () => ({
  presignUpload: vi.fn().mockResolvedValue('https://bucket.s3.example/signed-put'),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);
const presignMock = vi.mocked(presignUpload);

const body = { fileName: 'resume.pdf', contentType: 'application/pdf', sizeBytes: 47892 };

describe('POST /resume', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});
    presignMock.mockClear();
  });

  it('mints a URL pinned to the validated size and records a pending profile', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/resume', payload: body });

    expect(res.statusCode).toBe(201);
    const { uploadUrl, key } = res.json<{ uploadUrl: string; key: string }>();
    expect(uploadUrl).toBe('https://bucket.s3.example/signed-put');
    expect(key).toMatch(/^resumes\/me\/[0-9a-f-]+\.pdf$/);
    // The size the route validated is the size the URL signs — the cap can't be
    // sidestepped by declaring small and uploading big.
    expect(presignMock).toHaveBeenCalledWith(
      key,
      'application/pdf',
      body.sizeBytes,
      UPLOAD_URL_TTL_SECONDS,
    );

    const [put] = ddbMock.commandCalls(PutCommand);
    const item = put.args[0].input.Item as Record<string, unknown>;
    expect(item).toMatchObject({ fileName: 'resume.pdf', sizeKb: 47, parsed: false, s3Key: key });
    await app.close();
  });

  it('rejects a missing field', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/resume',
      payload: { fileName: 'resume.pdf' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects non-PDF content types', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/resume',
      payload: { ...body, contentType: 'application/msword' },
    });

    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it('rejects a fractional or non-positive sizeBytes', async () => {
    const app = buildApp();
    for (const sizeBytes of [0, -5, 1234.5]) {
      const res = await app.inject({ method: 'POST', url: '/resume', payload: { ...body, sizeBytes } });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it('413s over the cap without presigning or touching the stored profile', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/resume',
      payload: { ...body, sizeBytes: MAX_RESUME_SIZE_BYTES + 1 },
    });

    expect(res.statusCode).toBe(413);
    // A rejected request must not overwrite the current profile with a pending husk.
    expect(presignMock).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    await app.close();
  });
});

describe('GET /resume', () => {
  beforeEach(() => ddbMock.reset());

  it('404s before any upload', async () => {
    ddbMock.on(GetCommand).resolves({});
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/resume' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns the profile and never leaks rawText or s3Key', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        PK: 'USER#me',
        SK: 'PROFILE',
        fileName: 'resume.pdf',
        sizeKb: 47,
        pages: 2,
        parsed: true,
        targetRole: 'Backend Engineer',
        experience: 'Built things.',
        education: 'BS.',
        skills: ['TypeScript'],
        rawText: 'full resume text',
        s3Key: 'resumes/me/abc.pdf',
      },
    });
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/resume' });

    expect(res.statusCode).toBe(200);
    const profile = res.json<Record<string, unknown>>();
    expect(profile.parsed).toBe(true);
    expect(profile.rawText).toBeUndefined();
    expect(profile.s3Key).toBeUndefined();
    await app.close();
  });
});
