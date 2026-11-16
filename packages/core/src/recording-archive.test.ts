import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recordingArchiveFromEnv } from "./recording-archive";

it("S3 copia apenas cifrado com chave org/chamada, é idempotente e apaga sem expor o bucket", async () => {
  const requests: string[] = [];
  let object = false;
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url?.split("?")[0]}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    if (request.method === "HEAD") response.writeHead(object ? 200 : 404).end();
    else if (request.method === "PUT") {
      expect(Buffer.concat(chunks).includes(Buffer.from("OZREC001"))).toBe(true);
      object = true; response.writeHead(200, { ETag: '"stored"' }).end();
    } else { object = false; response.writeHead(204).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const dir = await mkdtemp(join(tmpdir(), "ozavo-archive-"));
  const org = "11111111-1111-4111-8111-111111111111";
  const call = "22222222-2222-4222-8222-222222222222";
  try {
    await mkdir(join(dir, org));
    const file = join(dir, org, `${call}.wav`);
    const archive = recordingArchiveFromEnv({ S3_ENDPOINT: `http://127.0.0.1:${address.port}`, S3_ACCESS_KEY_ID: "invented-access", S3_SECRET_ACCESS_KEY: "invented-local-secret" })!;
    await writeFile(file, "RIFFplain audio");
    await expect(archive.put(org, call, file)).rejects.toThrow(/Only encrypted/);
    await writeFile(file, "OZREC001encrypted-audio");
    await archive.put(org, call, file);
    await archive.put(org, call, file);
    expect(requests.filter(request => request.startsWith("PUT"))).toEqual([`PUT /recordings/${org}/${call}.wav.enc`]);
    await archive.remove(org, call);
    expect(object).toBe(false);
    await expect(archive.remove("../other", call)).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
