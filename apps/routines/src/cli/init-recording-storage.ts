import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { z } from "zod";

// Comando administrativo explícito, nunca chamado por `start` nem por uma migration.
const env = z.object({ S3_ENDPOINT: z.url(), S3_BUCKET: z.string().default("recordings"),
  S3_REGION: z.string().default("us-east-1"), S3_ACCESS_KEY_ID: z.string().min(1), S3_SECRET_ACCESS_KEY: z.string().min(1) }).parse(process.env);
const client = new S3Client({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } });
try {
  await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
} catch (error) {
  if (!(error instanceof Error && "$metadata" in error && (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404)) throw error;
  await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET,
    ...(env.S3_REGION !== "us-east-1" ? { CreateBucketConfiguration: { LocationConstraint: env.S3_REGION as "sa-east-1" } } : {}) }));
}
await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
process.stdout.write("Bucket de gravações conferido.\n");
client.destroy();
