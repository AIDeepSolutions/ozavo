import { createReadStream } from "node:fs";
import { stat, open } from "node:fs/promises";
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";

export interface RecordingArchive {
  put(organizationId: string, callId: string, file: string): Promise<void>;
  remove(organizationId: string, callId: string): Promise<void>;
}
const uuid = z.uuid();
const keyOf = (org: string, call: string): string => `${uuid.parse(org)}/${uuid.parse(call)}.wav.enc`;

/** Destino de infraestrutura gerado no preparo. Sem destino, a instalação usa só disco cifrado. */
export function recordingArchiveFromEnv(env: NodeJS.ProcessEnv): RecordingArchive | undefined {
  if (!env.S3_ENDPOINT) return undefined;
  const config = z.object({
    endpoint: z.url(), bucket: z.string().min(3), region: z.string().min(1),
    accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1),
  }).parse({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET ?? "recordings", region: env.S3_REGION ?? "us-east-1",
    accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY });
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 3 });
  return {
    async put(org, call, file) {
      const Key = keyOf(org, call);
      try {
        await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key }), { abortSignal: AbortSignal.timeout(10_000) });
        return;
      } catch (error) {
        if (!(error instanceof Error && "$metadata" in error &&
          (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404)) throw error;
      }
      // Nunca exporta os WAV legados em claro.
      const handle = await open(file);
      try {
        const magic = Buffer.alloc(8);
        await handle.read(magic, 0, 8, 0);
        if (magic.toString() !== "OZREC001") throw new Error("Only encrypted recordings may be archived");
      } finally { await handle.close(); }
      const info = await stat(file);
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key, Body: createReadStream(file),
        ContentLength: info.size, ContentType: "application/octet-stream" }), { abortSignal: AbortSignal.timeout(120_000) });
    },
    async remove(org, call) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: keyOf(org, call) }), { abortSignal: AbortSignal.timeout(10_000) });
    },
  };
}
