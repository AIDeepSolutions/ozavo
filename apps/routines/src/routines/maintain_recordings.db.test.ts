import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { recordingPath, readRecording, withOrg, withSystem } from "@ozavo/core";
import { afterAll, expect, it } from "vitest";
import { createCall, createOrganization, depsFor, openTestDbs, task, t0 } from "../../test/helpers";
import maintenance, { isOrphanSweepDay } from "./maintain_recordings";
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
    // A segunda passada não chama o S3 de novo: a chamada guarda a cópia e a exclusão remota (auditoria A19).
    expect(copied).toEqual([recent]); expect(removed).toEqual([expired]);
    const marks = await withOrg(app, org, q => q.many<{ id: string; archived: boolean; purged: boolean }>(
      "select id, recording_archived_at is not null as archived, recording_remote_purged_at is not null as purged from calls order by started_at"));
    expect(marks).toEqual([{ id: expired, archived: false, purged: true }, { id: recent, archived: true, purged: false }]);
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


it.each(["remove", "put"] as const)("falha S3 em %s não bloqueia expurgo local nem outros objetos, inclusive no retry", async failedOperation => {
  const dir = await mkdtemp(join(tmpdir(), "ozavo-archive-failure-"));
  try {
    const org = await createOrganization(app, "archive failure retention");
    const foreign = await createOrganization(app, "foreign archive failure retention");
    const old = new Date(t0.getTime() - 120 * 86400000);
    // A cópia recente vem antes das vencidas: put também pode falhar antes do expurgo.
    const recent = await createCall(app, org, t0);
    const expired = [await createCall(app, org, old), await createCall(app, org, old)];
    const other = await createCall(app, foreign, old);
    const wav = Buffer.alloc(48); wav.write("RIFF"); wav.writeUInt32LE(4, 40);
    for (const [organizationId, callId, at] of [[org, recent, t0], ...expired.map(id => [org, id, old] as const), [foreign, other, old]] as const) {
      await withSystem(app, q => q.exec("update calls set ended_at = $2 where id = $1", [callId, at]));
      const file = recordingPath(dir, organizationId, callId);
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, wav); await utimes(file, t0, t0);
    }
    const removed: string[] = [];
    const copied: string[] = [];
    const snapshots: string[][] = [];
    const deps = depsFor(app, { recordingsDir: dir, recordingArchive: {
      async remove(organizationId, callId) {
        expect(organizationId).toBe(org); removed.push(callId);
        snapshots.push(await readdir(join(dir, org)));
        if (failedOperation === "remove") throw new Error("invented S3 remove failure");
      },
      async put(organizationId, callId) {
        expect(organizationId).toBe(org); copied.push(callId);
        snapshots.push(await readdir(join(dir, org)));
        if (failedOperation === "put") throw new Error("invented S3 put failure");
      },
    } });
    for (const attempt of [1, 2]) {
      await expect(maintenance.run({ ...task(org, "maintain_recordings"), attempts: attempt }, deps)).rejects.toThrow("Recording maintenance failed");
      expect(await readdir(join(dir, org))).toEqual([`${recent}.wav`]);
      expect(await readRecording(recordingPath(dir, org, recent), deps.secretKey)).toEqual(wav);
      expect(await readdir(join(dir, foreign))).toEqual([`${other}.wav`]);
      // O que falhou é tentado de novo; o que deu certo não volta ao S3.
      for (const id of expired) expect(removed.filter(callId => callId === id)).toHaveLength(failedOperation === "remove" ? attempt : 1);
      expect(copied).toHaveLength(failedOperation === "put" ? attempt : 1);
      expect(snapshots.every(files => files.length === 1 && files[0] === `${recent}.wav`)).toBe(true);
    }
    const events = await withOrg(app, org, q => q.many<{ payload: { recordings: number } }>("select payload from organization_events where kind = 'recordings_purged'"));
    expect(events.map(event => event.payload.recordings)).toEqual([2]);
    const scheduled = await withOrg(app, org, q => q.many("select id from tasks where kind = 'maintain_recordings' and status = 'queued'"));
    expect(scheduled).toHaveLength(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("varredura semanal apaga do bucket a cópia vencida, a de chamada apagada e a sem chamada fora do prazo, e preserva o resto", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ozavo-orphans-"));
  try {
    const org = await createOrganization(app, "remote orphans");
    const foreign = await createOrganization(app, "remote orphans foreign");
    // O dia da varredura sai do id da organização: o teste anda até ele, sem depender de sorte.
    const day = [0, 1, 2, 3, 4, 5, 6].map(offset => new Date(t0.getTime() + offset * 86400000)).find(at => isOrphanSweepDay(org, at));
    if (!day) throw new Error("no sweep day in a week");
    const old = new Date(day.getTime() - 120 * 86400000);
    const live = await createCall(app, org, day);
    const expired = await createCall(app, org, old);
    const erased = await createCall(app, org, day);
    const otherOrg = await createCall(app, foreign, old);
    await withOrg(app, org, async q => {
      await q.exec("update calls set ended_at = $2 where id = $1", [live, day]);
      // A marca de cópia apagada se perdeu: o banco veio de um backup mais antigo que o bucket.
      await q.exec("update calls set ended_at = $2, recording_remote_purged_at = $2 where id = $1", [expired, old]);
      await q.exec("update calls set ended_at = $2, erased_at = $2, recording_remote_purged_at = $2 where id = $1", [erased, day]);
    });
    const noRowOld = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const noRowNew = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const bucket = new Map<string, Date>([[live, day], [expired, old], [erased, day], [noRowOld, old], [noRowNew, day], [otherOrg, old]]);
    const removed: string[] = [];
    const deps = depsFor(app, { recordingsDir: dir, clock: { now: () => day }, recordingArchive: {
      async put() { throw new Error("nothing to copy in this test"); },
      async remove(organizationId, callId) { expect(organizationId).toBe(org); removed.push(callId); bucket.delete(callId); },
      async *list(organizationId) {
        expect(organizationId).toBe(org);
        // A cópia da outra organização mora em outro prefixo: a lista desta não a traz, e ela fica.
        for (const [callId, modifiedAt] of bucket) if (callId !== otherOrg) yield { callId, modifiedAt };
      },
    } });
    await maintenance.run(task(org, "maintain_recordings"), deps);
    expect(removed.sort()).toEqual([erased, expired, noRowOld].sort());
    expect([...bucket.keys()].sort()).toEqual([live, noRowNew, otherOrg].sort());
    const events = await withOrg(app, org, q => q.many<{ payload: { copies: number } }>("select payload from organization_events where kind = 'remote_recordings_orphans_purged'"));
    expect(events.map(event => event.payload.copies)).toEqual([3]);

    // Fora do dia da varredura, o bucket não é listado.
    let listed = 0;
    const otherDay = new Date(day.getTime() + 86400000);
    await maintenance.run(task(org, "maintain_recordings"), depsFor(app, { recordingsDir: dir, clock: { now: () => otherDay }, recordingArchive: {
      async put() { throw new Error("nothing to copy in this test"); },
      async remove() { throw new Error("nothing to remove"); },
      async *list() { listed += 1; yield* []; },
    } }));
    expect(listed).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
