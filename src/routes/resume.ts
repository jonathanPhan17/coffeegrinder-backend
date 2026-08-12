import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getProfile, putPendingProfile } from '../data/resume-profile';
import {
  MAX_RESUME_SIZE_BYTES,
  RESUME_CONTENT_TYPE,
  UPLOAD_URL_TTL_SECONDS,
} from '../shared/constants';
import { presignUpload } from '../shared/s3';

interface CreateUploadBody {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export async function resumeRoutes(app: FastifyInstance): Promise<void> {
  // POST /resume — mint a presigned upload URL and record a pending profile.
  app.post<{ Body: CreateUploadBody }>('/resume', async (request, reply) => {
    const { fileName, contentType, sizeBytes } = request.body ?? ({} as CreateUploadBody);
    if (!fileName || !contentType || typeof sizeBytes !== 'number') {
      return reply.code(400).send({ error: 'fileName, contentType and sizeBytes are required' });
    }
    if (contentType !== RESUME_CONTENT_TYPE) {
      return reply.code(415).send({ error: 'Only application/pdf is supported' });
    }
    // sizeBytes becomes the signed content-length; a fraction or non-positive value
    // would sign a header no real request carries, minting a URL nothing can use.
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      return reply.code(400).send({ error: 'sizeBytes must be a positive integer' });
    }
    if (sizeBytes > MAX_RESUME_SIZE_BYTES) {
      return reply
        .code(413)
        .send({ error: `Resume must be ${MAX_RESUME_SIZE_BYTES / 1024 / 1024} MB or smaller` });
    }

    const key = `resumes/${request.userId}/${randomUUID()}.pdf`;
    const uploadUrl = await presignUpload(key, contentType, sizeBytes, UPLOAD_URL_TTL_SECONDS);
    await putPendingProfile(request.userId, {
      fileName,
      sizeKb: Math.max(1, Math.round(sizeBytes / 1024)),
      s3Key: key,
    });

    return reply.code(201).send({ uploadUrl, key });
  });

  // GET /resume — the current profile; frontend polls this until parsed=true.
  app.get('/resume', async (request, reply) => {
    const profile = await getProfile(request.userId);
    if (!profile) return reply.code(404).send({ error: 'No resume uploaded yet' });
    return profile;
  });
}
