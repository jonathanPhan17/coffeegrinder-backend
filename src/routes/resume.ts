import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getProfile, putPendingProfile } from '../data/resume-profile';
import {
  DEFAULT_USER_ID,
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

    const key = `resumes/${DEFAULT_USER_ID}/${randomUUID()}.pdf`;
    const uploadUrl = await presignUpload(key, contentType, UPLOAD_URL_TTL_SECONDS);
    await putPendingProfile(DEFAULT_USER_ID, {
      fileName,
      sizeKb: Math.max(1, Math.round(sizeBytes / 1024)),
      s3Key: key,
    });

    return reply.code(201).send({ uploadUrl, key });
  });

  // GET /resume — the current profile; frontend polls this until parsed=true.
  app.get('/resume', async (_request, reply) => {
    const profile = await getProfile(DEFAULT_USER_ID);
    if (!profile) return reply.code(404).send({ error: 'No resume uploaded yet' });
    return profile;
  });
}
