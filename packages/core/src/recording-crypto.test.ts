import { mkdtemp, mkdir, readFile, rm, writeFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { recordingEncryptor, decryptRecording, readRecording, recordingKey, sealLegacyRecording } from "./recording-crypto";

const key = Buffer.alloc(32, 9);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("autentica sequência, posições, chave, arquivo e fim; recusa truncamento e adulteração", () => {
  const encoder = recordingEncryptor(key);
  const header = Buffer.from("header");
  const audio = Buffer.from("private audio");
  const frames = [encoder.frame(header, 0), encoder.frame(audio, header.length), encoder.frame(Buffer.from("HEADER"), 0)];
  const encoded = Buffer.concat([encoder.header, ...frames, encoder.end(header.length + audio.length)]);
  expect(encoded.includes(audio)).toBe(false);
  expect(decryptRecording(encoded, key).toString()).toBe("HEADERprivate audio");
  expect(() => decryptRecording(encoded, Buffer.alloc(32, 8))).toThrow();
  expect(() => decryptRecording(encoded.subarray(0, -44), key)).toThrow();
  const changed = Buffer.from(encoded); changed[70] = (changed[70] ?? 0) ^ 1;
  expect(() => decryptRecording(changed, key)).toThrow();
  expect(() => decryptRecording(Buffer.concat([encoder.header, frames[1]!, frames[0]!, frames[2]!]), key)).toThrow();
});

it("cifra WAV legado em fluxo, preserva a idade para o expurgo e vincula à organização/chamada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ozavo-crypto-")); dirs.push(dir);
  const org = join(dir, "organization-a"); await mkdir(org);
  const file = join(org, "call.wav");
  const wav = Buffer.alloc(44 + 128000, 42); wav.write("RIFF"); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(file, wav);
  const at = new Date("2026-01-01T00:00:00Z"); await utimes(file, at, at);
  await sealLegacyRecording(file, key);
  expect((await readFile(file)).subarray(0, 8).toString()).toBe("OZREC001");
  expect((await stat(file)).mtime.getTime()).toBe(at.getTime());
  expect(await readRecording(file, key)).toEqual(wav);
  await sealLegacyRecording(file, key); // idempotente
  expect(await readRecording(file, key)).toEqual(wav);
  expect(recordingKey(file, key)).not.toEqual(recordingKey(join(dir, "organization-b/call.wav"), key));
  const encoded = await readFile(file); encoded[125] = (encoded[125] ?? 0) ^ 1; await writeFile(file, encoded);
  await expect(readRecording(file, key)).rejects.toThrow();
});
