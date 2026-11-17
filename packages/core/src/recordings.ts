import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Pasta das gravações de chamada: a voz grava, o painel lê e as rotinas apagam pelo prazo de guarda. */
export const DEFAULT_RECORDINGS_DIR = "/recordings";

/**
 * Gravação ligada, por organização (chave `calls.recording_enabled` em `settings`, registro 0016).
 * Ausente é desligada, de fábrica: quem atualiza não passa a gravar sem decidir. Só `true` liga.
 */
export const CALL_RECORDING_SETTING = "calls.recording_enabled";
export const callRecordingOf = (stored: unknown): boolean => stored === true;

/** Onde fica a gravação de uma chamada: uma pasta por organização, um WAV por chamada. */
export function recordingPath(dir: string, organizationId: string, callId: string): string {
  return path.join(dir, organizationId, `${callId}.wav`);
}

/**
 * Prazo de guarda das gravações: apaga as de UMA organização gravadas antes de `before` e devolve
 * quantas saíram. A data é a do arquivo, escrito quando a chamada termina. Sem pasta (nenhuma
 * chamada gravada ainda), não há o que apagar. `knownCallIds` exclui chamadas cuja idade é decidida pelo banco.
 *
 * Um arquivo que não sai não interrompe os seguintes. Com `failures`, os erros entram ali e a
 * contagem do que saiu é devolvida, para quem audita. Sem ele, depois de tentar todos, lança um
 * `AggregateError` (a contagem se perderia: só quem não audita chama assim).
 */
export async function purgeRecordings(dir: string, organizationId: string, before: Date, knownCallIds: ReadonlySet<string> = new Set(), failures?: unknown[]): Promise<number> {
  if (!/^[0-9a-f-]{36}$/i.test(organizationId)) throw new Error("purgeRecordings needs one organization id");
  const folder = path.join(dir, organizationId);
  const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let removed = 0;
  const errors: unknown[] = [];
  for (const name of names) {
    if (!name.endsWith(".wav") || knownCallIds.has(name.slice(0, -4))) continue;
    const file = path.join(folder, name);
    const info = await stat(file).catch(() => null);
    if (!info || info.mtime >= before) continue;
    try { await rm(file, { force: true }); removed += 1; }
    catch (error) { errors.push(error); }
  }
  if (failures) failures.push(...errors);
  else if (errors.length > 0) throw new AggregateError(errors, `purgeRecordings failed on ${errors.length} file(s)`);
  return removed;
}
