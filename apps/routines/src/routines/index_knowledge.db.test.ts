import { encryptSecret, MAX_TASK_ATTEMPTS, KNOWLEDGE_LIMITS, claimKnowledgeVersion, createKnowledgeSource, getKnowledgeSource, searchKnowledge, withOrg, withSystem, type ClaimedTask } from "@ozavo/core";
import { afterAll, describe, expect, it } from "vitest";
import { fakeEmbedding, fakeEmbeddingsFetch } from "../../../../packages/core/test/fake-embeddings";
import { makeDocx, makePdf } from "../../test/documents";
import { createOrganization, depsFor, openTestDbs, putSetting, secretKey, t0, task } from "../../test/helpers";
import indexKnowledge from "./index_knowledge";

const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

/** Consulta direta, como o sistema, para conferir o que a rotina deixou no banco. */
const rows = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => withSystem(app, (q) => q.many<T>(sql, params));

const PIPELINE_KEY = "engine.deepgram-openrouter-cartesia.api_key";
const withKey = (org: string): Promise<void> =>
  putSetting(app, org, PIPELINE_KEY, encryptSecret(JSON.stringify({ deepgram: "dg", cartesia: "ca", openrouter: "sk-or-teste" }), secretKey));

const MANUAL = ["# Horários", "A clínica atende de segunda a sexta, das oito às dezoito horas.", "# Preços", "A consulta de avaliação custa cento e cinquenta reais."].join("\n\n");

async function enqueue(org: string, input: { kind: "pdf" | "docx" | "md" | "txt" | "text"; raw?: Buffer; text?: string }): Promise<{ sourceId: string; versionId: string }> {
  return withOrg(app, org, (q) => createKnowledgeSource(q, { name: "Doc", createdBy: null, now: t0, ...input }));
}
const run = (org: string, versionId: string, extra: { fetch?: typeof fetch; attempts?: number } = {}): Promise<void> => {
  const claimed: ClaimedTask = { ...task(org, "index_knowledge", { versionId }), attempts: extra.attempts ?? 1 };
  return indexKnowledge.run(claimed, depsFor(app, { fetch: extra.fetch ?? fakeEmbeddingsFetch() }));
};
const sourceOf = (org: string, id: string) => withOrg(app, org, (q) => getKnowledgeSource(q, id));

describe("index_knowledge", () => {
  it("indexa um texto colado: trechos com embedding, custo e uso registrados, e a busca acha", async () => {
    const org = await createOrganization(app, "idx text");
    await withKey(org);
    const { sourceId, versionId } = await enqueue(org, { kind: "text", text: MANUAL });
    const calls: Array<{ inputs: string[]; authorization: string | null }> = [];
    await run(org, versionId, { fetch: fakeEmbeddingsFetch(calls) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer sk-or-teste");
    const source = await sourceOf(org, sourceId);
    expect(source).toMatchObject({ status: "ready", errorCode: null, indexedAt: t0 });
    expect(source?.chunkCount).toBeGreaterThanOrEqual(1);
    expect(source?.indexCostMicrocents).toBeGreaterThan(0);
    const usage = await rows("select kind, model, tokens, cost_microcents::int as cost from knowledge_usage where organization_id = $1", [org]);
    expect(usage).toEqual([{ kind: "index", model: "openai/text-embedding-3-small", tokens: expect.any(Number), cost: source?.indexCostMicrocents }]);
    const hits = await withOrg(app, org, (q) => searchKnowledge(q, { sourceIds: [sourceId], question: "quanto custa a consulta", embedding: fakeEmbedding("quanto custa a consulta"), k: 2 }));
    expect(hits[0]?.content).toContain("cento e cinquenta reais");
  });

  it("indexa PDF e DOCX de verdade e descarta o arquivo bruto", async () => {
    const org = await createOrganization(app, "idx files");
    await withKey(org);
    const pdf = await enqueue(org, { kind: "pdf", raw: makePdf([["Preços", "A limpeza custa duzentos reais."], ["Convênios", "Aceitamos Unimed."]]) });
    const docx = await enqueue(org, { kind: "docx", raw: await makeDocx(["# Cancelamento", "O cancelamento é gratuito até 24 horas antes."]) });
    await run(org, pdf.versionId);
    await run(org, docx.versionId);
    expect(await sourceOf(org, pdf.sourceId)).toMatchObject({ status: "ready" });
    expect(await sourceOf(org, docx.sourceId)).toMatchObject({ status: "ready" });
    const stored = (await rows<{ no_raw: boolean; content_text: string }>("select raw is null as no_raw, content_text from knowledge_versions where organization_id = $1 order by created_at", [org]));
    expect(stored.every((row) => row.no_raw)).toBe(true);
    expect(stored.map((row) => row.content_text).join("\n")).toContain("A limpeza custa duzentos reais.");
    const hits = await withOrg(app, org, (q) => searchKnowledge(q, { sourceIds: [docx.sourceId], question: "cancelamento gratuito", embedding: fakeEmbedding("cancelamento gratuito"), k: 1 }));
    expect(hits[0]?.section).toBe("Cancelamento");
  });

  it("repetir a tarefa de uma versão já pronta não gasta nem muda nada", async () => {
    const org = await createOrganization(app, "idx idempotent");
    await withKey(org);
    const { versionId } = await enqueue(org, { kind: "text", text: MANUAL });
    await run(org, versionId);
    const calls: Array<{ inputs: string[]; authorization: string | null }> = [];
    await run(org, versionId, { fetch: fakeEmbeddingsFetch(calls) });
    expect(calls).toEqual([]);
    expect((await rows("select count(*)::int as n from knowledge_usage where organization_id = $1", [org]))[0]).toEqual({ n: 1 });
  });

  it("sem a chave do OpenRouter, marca a falha com o motivo e não chama ninguém", async () => {
    const org = await createOrganization(app, "idx nokey");
    const { sourceId, versionId } = await enqueue(org, { kind: "text", text: MANUAL });
    const calls: Array<{ inputs: string[]; authorization: string | null }> = [];
    await run(org, versionId, { fetch: fakeEmbeddingsFetch(calls) });
    expect(calls).toEqual([]);
    expect(await sourceOf(org, sourceId)).toMatchObject({ status: "failed", errorCode: "no_embedding_key" });
    // O texto extraído fica: dá para reindexar quando a chave chegar, sem enviar o arquivo de novo.
    expect((await rows("select content_text from knowledge_versions where id = $1", [versionId]))[0]).toEqual({ content_text: MANUAL });
  });

  it("marca arquivo ilegível e PDF só de imagem sem repetir a tarefa", async () => {
    const org = await createOrganization(app, "idx bad files");
    await withKey(org);
    const broken = await enqueue(org, { kind: "pdf", raw: Buffer.from("não sou um pdf") });
    const scanned = await enqueue(org, { kind: "pdf", raw: makePdf([[]]) });
    const empty = await enqueue(org, { kind: "txt", raw: Buffer.from("   \n  ") });
    for (const item of [broken, scanned, empty]) await run(org, item.versionId);
    expect((await sourceOf(org, broken.sourceId))?.errorCode).toBe("unreadable_file");
    expect((await sourceOf(org, scanned.sourceId))?.errorCode).toBe("scanned_pdf");
    expect((await sourceOf(org, empty.sourceId))?.errorCode).toBe("empty_text");
  });

  it("respeita o teto da empresa: indexar além dele falha com `organization_quota`", async () => {
    const org = await createOrganization(app, "idx quota");
    await withKey(org);
    // Outra fonte já ocupa quase tudo (número gravado direto: o teste não vai indexar 5 milhões de tokens).
    const existing = await enqueue(org, { kind: "text", text: MANUAL });
    const extra = await enqueue(org, { kind: "text", text: MANUAL });
    await rows("update knowledge_sources set token_count = $2 where id = $1 returning id", [existing.sourceId, KNOWLEDGE_LIMITS.maxOrganizationTokens - 5]);
    // O envio de um texto colado que já estoura o teto é recusado na hora, sem enfileirar nada.
    await expect(enqueue(org, { kind: "text", text: "palavra ".repeat(100) })).rejects.toMatchObject({ code: "organization_quota" });
    await run(org, extra.versionId);
    expect(await sourceOf(org, extra.sourceId)).toMatchObject({ status: "failed", errorCode: "organization_quota" });
  });

  it("falha de rede devolve a tarefa à fila e só na última tentativa marca a falha; recusa de chave marca na hora", async () => {
    const org = await createOrganization(app, "idx network");
    await withKey(org);
    const down = (async () => new Response("", { status: 503 })) as typeof fetch;
    const { sourceId, versionId } = await enqueue(org, { kind: "text", text: MANUAL });
    await expect(run(org, versionId, { fetch: down, attempts: 1 })).rejects.toMatchObject({ code: "embedding_http", retryable: true });
    expect(await sourceOf(org, sourceId)).toMatchObject({ status: "processing", errorCode: null });
    await expect(run(org, versionId, { fetch: down, attempts: MAX_TASK_ATTEMPTS })).rejects.toMatchObject({ retryable: true });
    expect(await sourceOf(org, sourceId)).toMatchObject({ status: "failed", errorCode: "embedding_failed" });

    const refused = await enqueue(org, { kind: "text", text: MANUAL });
    await run(org, refused.versionId, { fetch: (async () => new Response("", { status: 401 })) as typeof fetch });
    expect(await sourceOf(org, refused.sourceId)).toMatchObject({ status: "failed", errorCode: "embedding_rejected" });
  });

  it("a fonte apagada no meio do caminho não deixa tarefa pendurada", async () => {
    const org = await createOrganization(app, "idx deleted");
    await withKey(org);
    const { sourceId, versionId } = await enqueue(org, { kind: "text", text: MANUAL });
    await rows("delete from knowledge_sources where id = $1 returning id", [sourceId]);
    await expect(run(org, versionId)).resolves.toBeUndefined();
    expect(await withOrg(app, org, (q) => claimKnowledgeVersion(q, versionId, t0))).toBeNull();
  });
});
