import { mkdtemp, mkdir, rm, writeFile, utimes, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const statFailures = vi.hoisted(() => new Map<string, NodeJS.ErrnoException>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const realStat = real.stat as (target: string) => Promise<unknown>;
  return {
    ...real,
    stat: async (target: string) => {
      const injected = statFailures.get(String(target));
      if (injected) throw injected;
      return realStat(target);
    },
  };
});

import { purgeRecordings } from "./recordings";

const ORG = "11111111-1111-4111-8111-111111111111";
const OLD = new Date("2026-01-01T00:00:00Z");
const CUTOFF = new Date("2026-06-01T00:00:00Z");
let dir: string;
let folder: string;

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
const exists = (file: string) => access(file).then(() => true, () => false);
async function wav(name: string): Promise<string> {
  const file = path.join(folder, name);
  await writeFile(file, "x");
  await utimes(file, OLD, OLD);
  return file;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ozavo-rec-"));
  folder = path.join(dir, ORG);
  await mkdir(folder);
  statFailures.clear();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

it("erro de stat que não é ENOENT vai para as falhas e o arquivo não conta como removido", async () => {
  const bad = await wav("aaaa.wav");
  const good = await wav("bbbb.wav");
  statFailures.set(bad, errno("EACCES"));
  const failures: unknown[] = [];
  const removed = await purgeRecordings(dir, ORG, CUTOFF, new Set(), failures);
  expect(removed).toBe(1);
  expect(failures).toHaveLength(1);
  expect((failures[0] as NodeJS.ErrnoException).code).toBe("EACCES");
  expect(await exists(bad)).toBe(true);
  expect(await exists(good)).toBe(false);
});

it("sem a lista de falhas, o erro de stat que não é ENOENT sobe como AggregateError", async () => {
  const bad = await wav("aaaa.wav");
  statFailures.set(bad, errno("EIO"));
  await expect(purgeRecordings(dir, ORG, CUTOFF)).rejects.toBeInstanceOf(AggregateError);
});

it("arquivo que some entre a listagem e o stat (ENOENT) é ignorado, sem falha", async () => {
  const gone = await wav("aaaa.wav");
  statFailures.set(gone, errno("ENOENT"));
  const failures: unknown[] = [];
  expect(await purgeRecordings(dir, ORG, CUTOFF, new Set(), failures)).toBe(0);
  expect(failures).toEqual([]);
});
