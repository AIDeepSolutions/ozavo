import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { recordingPath, readRecording, withOrg, withSystem } from "@ozavo/core";
import { afterAll, expect, it } from "vitest";
import { createCall, createOrganization, depsFor, openTestDbs, task, t0 } from "../../test/helpers";
import maintenance from "./maintain_recordings";
const { app, owner } = openTestDbs();
afterAll(async () => { await app.close(); await owner.close(); });

it("90 dias sem configuração: expurga só o vencido, cifra legado, copia S3 e mantém uma corrente por organização", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ozavo-retention-"));
  try {
    const org = await createOrganization(app, "audio retention");
    const foreign = await createOrganization(app, "foreign audio");
    const expiredAt = new Date(t0.getTime() - 91 * 86400000);
    const recentAt = new Date(t0.getTime() - 2 * 86400000);
    const expired = await createCall(app, org, expiredAt);
    const recent = await createCall(app, org, recentAt);
    const other = await createCall(app, foreign, expiredAt);
    const wav = Buffer.alloc(48); wav.write("RIFF"); wav.writeUInt32LE(4, 40);
    for (const [organizationId, callId, at] of [[org, expired, expiredAt], [org, recent, recentAt], [foreign, other, expiredAt]] as const) {
      await withSystem(app, q => q.exec("update calls set ended_at = $2 where id = $1", [callId, at]));
      const file = recordingPath(dir, organizationId, callId); await mkdir(dirname(file), { recursive: true });
      await writeFile(file, wav);
      // Cópia restaurada renova mtime do vencido; a recente pode ter mtime antigo.
      const modified = callId === expired ? t0 : callId === recent ? expiredAt : at;
      await utimes(file, modified, modified);
    }
    const copied: string[] = []; const removed: string[] = [];
    const deps = depsFor(app, { recordingsDir: dir, recordingArchive: {
      async put(organizationId, callId, file) {
        expect(organizationId).toBe(org);
        expect((await readFile(file)).subarray(0, 8).toString()).toBe("OZREC001"); copied.push(callId);
      },
      async remove(organizationId, callId) { expect(organizationId).toBe(org); removed.push(callId); },
    } });
    await maintenance.run(task(org, "maintain_recordings"), deps);
    await maintenance.run(task(org, "maintain_recordings"), deps);
    expect(await readdir(join(dir, org))).toEqual([`${recent}.wav`]);
    expect(await readRecording(recordingPath(dir, org, recent), deps.secretKey)).toEqual(wav);
    expect(await readdir(join(dir, foreign))).toEqual([`${other}.wav`]);
    expect(copied).toEqual([recent, recent]); expect(removed).toEqual([expired, expired]);
    const scheduled = await withOrg(app, org, q => q.many<{ run_at: Date }>("select run_at from tasks where kind = 'maintain_recordings' and status = 'queued'"));
    expect(scheduled).toEqual([{ run_at: new Date(t0.getTime() + 86400000) }]);
    const events = await withOrg(app, org, q => q.many<{ kind: string }>("select kind from organization_events where kind = 'recordings_purged'"));
    expect(events).toEqual([{ kind: "recordings_purged" }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


it("a manutenção corrige o arquivo local de chamada apagada, mesmo com mtime novo e sem cópia remota", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ozavo-erased-maintenance-"));
  try {
    const org = await createOrganization(app, "erased audio maintenance");
    const callId = await createCall(app, org, t0);
    await withOrg(app, org, q => q.exec("update calls set ended_at = $2, erased_at = $2 where id = $1", [callId, t0]));
    const file = recordingPath(dir, org, callId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "legacy erased audio");
    await writeFile(`${file}.part`, "partial erased audio");
    await utimes(file, t0, t0);
    await maintenance.run(task(org, "maintain_recordings"), depsFor(app, { recordingsDir: dir }));
    expect(await readdir(dirname(file))).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
