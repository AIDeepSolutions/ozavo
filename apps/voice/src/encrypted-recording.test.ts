import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readRecording } from "@ozavo/core";
import { startRecording } from "./recording";

it("grava e pausa sem PCM em disco; exporta WAV com hash conferível e recusa troca de organização", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ozavo-encrypted-recording-"));
  try {
    const file = join(dir, "org-a/call.wav");
    const key = Buffer.alloc(32, 7);
    let at = 0;
    const recorder = await startRecording(file, () => at, { encryptionKey: key });
    const audio = Buffer.alloc(16000, 33);
    recorder.caller(audio);
    at = 2200;
    recorder.agent(audio);
    await recorder.pause();
    const partial = await readFile(`${file}.part`);
    expect(partial.subarray(0, 8).toString()).toBe("OZREC001");
    expect(partial.includes(audio)).toBe(false);
    const result = await recorder.finish();
    expect(result).not.toBe(false);
    const wav = await readRecording(file, key);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(result).toEqual({ bytes: wav.length, sha256: createHash("sha256").update(wav).digest("hex") });
    await expect(readRecording(file, Buffer.alloc(32, 6))).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
