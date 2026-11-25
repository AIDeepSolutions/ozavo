import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { fakeEmbedding } from "../test/fake-embeddings";
import { EMBEDDING_MODEL } from "./embeddings";
import { chunkText } from "./knowledge-chunking";
import {
  FULL_PROMPT_MAX_TOKENS,
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_TASK_KIND,
  KnowledgeLimitError,
  claimKnowledgeVersion,
  completeKnowledgeVersion,
  createKnowledgeSource,
  deleteKnowledgeSource,
  failKnowledgeVersion,
  getAgentKnowledge,
  getKnowledgeCost,
  getKnowledgeSource,
  getKnowledgeUsage,
  listKnowledgeSources,
  loadKnowledgeDocuments,
  reindexKnowledgeSource,
  renameKnowledgeSource,
  replaceKnowledgeSource,
  resolveKnowledgeMode,
  searchKnowledge,
  setAgentKnowledge,
  type OrgQuery,
} from "./index";
import { withOrg } from "./with-org";

const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const now = new Date("2031-03-01T09:00:00Z");
const later = new Date("2031-03-01T09:05:00Z");

const TEXT_A = [
  "# Horários",
  "A clínica atende de segunda a sexta, das oito às dezoito horas, e aos sábados até o meio-dia.",
  "# Preços",
  "A consulta de avaliação custa cento e cinquenta reais. A limpeza custa duzentos reais.",
  "# Convênios",
  "Aceitamos os convênios Unimed e Bradesco Saúde, com carência de noventa dias para tratamentos.",
].join("\n\n");

/** Cria a fonte e a deixa pronta, como a rotina faria, com embeddings falsos. */
async function indexed(q: OrgQuery, name: string, text: string, at = now): Promise<{ sourceId: string; versionId: string }> {
  const created = await createKnowledgeSource(q, { name, kind: "text", text, createdBy: null, now: at });
  const claimed = await claimKnowledgeVersion(q, created.versionId, at);
  if (!claimed) throw new Error("not claimed");
  const chunks = chunkText(text);
  await completeKnowledgeVersion(q, {
    versionId: created.versionId,
    sourceId: created.sourceId,
    text,
    chunks: chunks.map((chunk) => ({ ...chunk, embedding: fakeEmbedding(chunk.content) })),
    tokenCount: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
    embeddingTokens: 100,
    costMicrocents: 2000,
    now: at,
  });
  return created;
}

const createAgent = async (org: string, name = "Agente"): Promise<string> =>
  (await owner.pool.query<{ id: string }>("insert into agents (organization_id, name, engine) values ($1, $2, 'simulated') returning id", [org, name])).rows[0]?.id ?? "";

describe("fontes da base de conhecimento", () => {
  it("cria a fonte na fila, com a versão 1 e a tarefa de indexação", async () => {
    const org = await createOrganization(app, "kb create");
    const created = await withOrg(app, org, (q) => createKnowledgeSource(q, { name: "  Manual  ", kind: "text", text: TEXT_A, createdBy: null, now }));
    const source = await withOrg(app, org, (q) => getKnowledgeSource(q, created.sourceId));
    expect(source).toMatchObject({ name: "Manual", kind: "text", status: "queued", currentVersionId: null, tokenCount: 0, chunkCount: 0, embeddingModel: EMBEDDING_MODEL, latestVersion: 1, agentCount: 0 });
    const tasks = (await owner.pool.query("select kind, payload from tasks where organization_id = $1", [org])).rows;
    expect(tasks).toEqual([{ kind: KNOWLEDGE_TASK_KIND, payload: { versionId: created.versionId } }]);
  });

  it("recusa nome vazio, arquivo vazio, arquivo grande demais e texto vazio", async () => {
    const org = await createOrganization(app, "kb limits");
    const make = (input: Partial<Parameters<typeof createKnowledgeSource>[1]>) =>
      withOrg(app, org, (q) => createKnowledgeSource(q, { name: "x", kind: "text", text: "a", createdBy: null, now, ...input }));
    await expect(make({ name: "  " })).rejects.toMatchObject({ code: "name" });
    await expect(make({ text: "   " })).rejects.toMatchObject({ code: "empty" });
    await expect(make({ kind: "pdf", raw: Buffer.alloc(0), text: undefined })).rejects.toMatchObject({ code: "empty" });
    await expect(make({ kind: "pdf", raw: Buffer.alloc(KNOWLEDGE_LIMITS.maxFileBytes + 1), text: undefined })).rejects.toBeInstanceOf(KnowledgeLimitError);
    await expect(make({ text: "x".repeat(KNOWLEDGE_LIMITS.maxTextCharacters + 1) })).rejects.toMatchObject({ code: "text_too_large" });
    expect(await withOrg(app, org, (q) => listKnowledgeSources(q))).toEqual([]);
    expect((await owner.pool.query("select count(*)::int as n from tasks where organization_id = $1", [org])).rows[0]).toEqual({ n: 0 });
  });

  it("publica a versão pronta, guarda custo e tokens e põe o texto à disposição da base inteira", async () => {
    const org = await createOrganization(app, "kb ready");
    const { sourceId } = await withOrg(app, org, (q) => indexed(q, "Manual", TEXT_A));
    const source = await withOrg(app, org, (q) => getKnowledgeSource(q, sourceId));
    expect(source).toMatchObject({ status: "ready", errorCode: null, indexCostMicrocents: 2000, indexedAt: now });
    expect(source?.chunkCount).toBeGreaterThanOrEqual(1);
    expect(source?.tokenCount).toBeGreaterThan(20);
    expect(source?.currentVersionId).not.toBeNull();
    const docs = await withOrg(app, org, (q) => loadKnowledgeDocuments(q, [sourceId]));
    expect(docs).toEqual([{ id: sourceId, name: "Manual", tokenCount: source?.tokenCount, text: TEXT_A }]);
    const usage = await withOrg(app, org, (q) => getKnowledgeUsage(q));
    expect(usage).toEqual({ tokens: source?.tokenCount, sources: 1, indexCostMicrocents: 2000 });
    const cost = await withOrg(app, org, (q) => getKnowledgeCost(q, new Date("2031-03-01T00:00:00Z"), new Date("2031-04-01T00:00:00Z")));
    expect(cost).toEqual({ indexTokens: 100, indexCostMicrocents: 2000, searchTokens: 0, searchCostMicrocents: 0 });
  });

  it("troca o arquivo sem derrubar a base: a versão antiga responde até a nova ficar pronta, e depois sai", async () => {
    const org = await createOrganization(app, "kb versions");
    const { sourceId, versionId: v1 } = await withOrg(app, org, (q) => indexed(q, "Manual", TEXT_A));
    const hits = (text: string) => withOrg(app, org, (q) => searchKnowledge(q, { sourceIds: [sourceId], question: text, embedding: fakeEmbedding(text), k: 3 }));
    expect((await hits("quanto custa a consulta de avaliação"))[0]?.content).toContain("cento e cinquenta reais");

    const replaced = await withOrg(app, org, (q) => replaceKnowledgeSource(q, sourceId, { kind: "text", text: "# Preços\n\nA consulta de avaliação agora custa duzentos e vinte reais.", createdBy: null, now: later }));
    // Enquanto a nova indexa, a antiga continua respondendo.
    expect(await withOrg(app, org, (q) => getKnowledgeSource(q, sourceId))).toMatchObject({ status: "queued", currentVersionId: v1, latestVersion: 2 });
    expect((await hits("quanto custa a consulta de avaliação"))[0]?.content).toContain("cento e cinquenta reais");

    await withOrg(app, org, async (q) => {
      const claimed = await claimKnowledgeVersion(q, replaced.versionId, later);
      expect(claimed?.version).toBe(2);
      const text = claimed?.contentText ?? "";
      const chunks = chunkText(text);
      await completeKnowledgeVersion(q, {
        versionId: replaced.versionId,
        sourceId,
        text,
        chunks: chunks.map((chunk) => ({ ...chunk, embedding: fakeEmbedding(chunk.content) })),
        tokenCount: 30,
        embeddingTokens: 30,
        costMicrocents: 600,
        now: later,
      });
    });
    const found = await hits("quanto custa a consulta de avaliação");
    expect(found[0]?.content).toContain("duzentos e vinte reais");
    expect(found.some((hit) => hit.content.includes("cento e cinquenta"))).toBe(false);
    expect(await withOrg(app, org, (q) => getKnowledgeSource(q, sourceId))).toMatchObject({ status: "ready", currentVersionId: replaced.versionId, tokenCount: 30, indexCostMicrocents: 2600 });
    const versions = (await owner.pool.query("select version, status, content_text is null as no_text from knowledge_versions where source_id = $1 order by version", [sourceId])).rows;
    expect(versions).toEqual([
      { version: 1, status: "superseded", no_text: true },
      { version: 2, status: "ready", no_text: false },
    ]);
    expect((await owner.pool.query("select count(*)::int as n from knowledge_chunks where version_id = $1", [v1])).rows[0]).toEqual({ n: 0 });
  });

  it("reindexa o texto já extraído sem novo envio, e recusa quando não há texto", async () => {
    const org = await createOrganization(app, "kb reindex");
    const { sourceId } = await withOrg(app, org, (q) => indexed(q, "Manual", TEXT_A));
    const again = await withOrg(app, org, (q) => reindexKnowledgeSource(q, sourceId, null, later));
    const claimed = await withOrg(app, org, (q) => claimKnowledgeVersion(q, again.versionId, later));
    expect(claimed).toMatchObject({ version: 2, contentText: TEXT_A, raw: null });

    const failedOrg = await createOrganization(app, "kb reindex none");
    const pdf = await withOrg(app, failedOrg, (q) => createKnowledgeSource(q, { name: "Escaneado", kind: "pdf", raw: Buffer.from("%PDF-1.4"), createdBy: null, now }));
    await withOrg(app, failedOrg, async (q) => {
      await claimKnowledgeVersion(q, pdf.versionId, now);
      await failKnowledgeVersion(q, pdf.versionId, "scanned_pdf", now);
    });
    expect(await withOrg(app, failedOrg, (q) => getKnowledgeSource(q, pdf.sourceId))).toMatchObject({ status: "failed", errorCode: "scanned_pdf" });
    await expect(withOrg(app, failedOrg, (q) => reindexKnowledgeSource(q, pdf.sourceId, null, later))).rejects.toMatchObject({ code: "no_text" });
    // O arquivo bruto não fica depois da falha.
    expect((await owner.pool.query("select raw is null as gone from knowledge_versions where id = $1", [pdf.versionId])).rows[0]).toEqual({ gone: true });
  });

  it("renomeia e apaga a fonte com versões, trechos e vínculos, mantendo o custo registrado", async () => {
    const org = await createOrganization(app, "kb delete");
    const agent = await createAgent(org);
    const { sourceId } = await withOrg(app, org, (q) => indexed(q, "Manual", TEXT_A));
    await withOrg(app, org, (q) => setAgentKnowledge(q, agent, { sourceIds: [sourceId], mode: "rag", only: false }, now));
    expect(await withOrg(app, org, (q) => renameKnowledgeSource(q, sourceId, "Manual 2", later))).toBe(true);
    expect((await withOrg(app, org, (q) => getKnowledgeSource(q, sourceId)))?.name).toBe("Manual 2");
    expect(await withOrg(app, org, (q) => deleteKnowledgeSource(q, sourceId))).toBe(true);
    for (const table of ["knowledge_versions", "knowledge_chunks", "agent_knowledge_sources"]) {
      expect((await owner.pool.query(`select count(*)::int as n from ${table} where organization_id = $1`, [org])).rows[0], table).toEqual({ n: 0 });
    }
    expect((await owner.pool.query("select source_id, version_id from knowledge_usage where organization_id = $1", [org])).rows).toEqual([{ source_id: null, version_id: null }]);
    expect(await withOrg(app, org, (q) => deleteKnowledgeSource(q, sourceId))).toBe(false);
  });

  it("não deixa uma empresa ver, buscar nem vincular a base de outra", async () => {
    const orgA = await createOrganization(app, "kb iso A");
    const orgB = await createOrganization(app, "kb iso B");
    const { sourceId } = await withOrg(app, orgA, (q) => indexed(q, "Segredo da A", TEXT_A));
    expect(await withOrg(app, orgB, (q) => listKnowledgeSources(q))).toEqual([]);
    expect(await withOrg(app, orgB, (q) => searchKnowledge(q, { sourceIds: [sourceId], question: "consulta", embedding: fakeEmbedding("consulta"), k: 3 }))).toEqual([]);
    expect(await withOrg(app, orgB, (q) => loadKnowledgeDocuments(q, [sourceId]))).toEqual([]);
    const agentB = await createAgent(orgB);
    await expect(withOrg(app, orgB, (q) => setAgentKnowledge(q, agentB, { sourceIds: [sourceId], mode: "rag", only: false }, now))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("busca", () => {
  const FAQ = [
    "# Cancelamento",
    "O cancelamento sem custo vale até vinte e quatro horas antes da consulta. Depois disso, cobramos cinquenta por cento do valor.",
    "# Estacionamento",
    "A unidade Centro tem estacionamento conveniado na rua lateral, com desconto para pacientes.",
    "# Pagamento",
    "Aceitamos cartão de crédito em até dez vezes sem juros e Pix com cinco por cento de desconto.",
  ].join("\n\n");

  it("acha o trecho pela similaridade, pelas palavras e pelos dois, e diz de onde veio", async () => {
    const org = await createOrganization(app, "kb search");
    const { sourceId } = await withOrg(app, org, (q) => indexed(q, "FAQ", FAQ));
    const search = (question: string, embedding: readonly number[] | null) => withOrg(app, org, (q) => searchKnowledge(q, { sourceIds: [sourceId], question, embedding, k: 2 }));

    const both = await search("posso cancelar a consulta com vinte e quatro horas", fakeEmbedding("posso cancelar a consulta com vinte e quatro horas"));
    expect(both[0]?.content).toContain("cancelamento sem custo");
    expect(both[0]?.vectorScore).toBeGreaterThan(0.2);
    expect(both[0]?.lexicalRank).toBe(1);
    expect(both[0]?.sourceName).toBe("FAQ");

    // Sem embedding (atrasou ou falhou): só as palavras, e ainda acha.
    const lexicalOnly = await search("tem estacionamento?", null);
    expect(lexicalOnly[0]?.content).toContain("estacionamento conveniado");
    expect(lexicalOnly[0]).toMatchObject({ vectorScore: null, lexicalRank: 1 });

    // Só o embedding, sem palavra útil na pergunta.
    const vectorOnly = await search("o que é isso?", fakeEmbedding("estacionamento conveniado desconto pacientes"));
    expect(vectorOnly[0]?.content).toContain("estacionamento conveniado");
    expect(vectorOnly[0]?.lexicalRank).toBeNull();
  });

  it("não devolve trecho que só é parecido com tudo", async () => {
    const org = await createOrganization(app, "kb search floor");
    const { sourceId } = await withOrg(app, org, (q) => indexed(q, "FAQ", FAQ));
    const nothing = await withOrg(app, org, (q) => searchKnowledge(q, { sourceIds: [sourceId], question: "?", embedding: fakeEmbedding("receita de bolo de cenoura com cobertura"), k: 3 }));
    expect(nothing).toEqual([]);
  });

  it("busca só nas fontes pedidas e nunca devolve trecho de versão antiga", async () => {
    const org = await createOrganization(app, "kb search sources");
    const a = await withOrg(app, org, (q) => indexed(q, "A", "# Preços\n\nA limpeza dental custa duzentos reais na tabela da casa."));
    const b = await withOrg(app, org, (q) => indexed(q, "B", "# Preços\n\nO clareamento dental custa oitocentos reais na tabela da casa."));
    const ask = (ids: string[]) => withOrg(app, org, (q) => searchKnowledge(q, { sourceIds: ids, question: "quanto custa dental na tabela", embedding: fakeEmbedding("quanto custa dental na tabela"), k: 5 }));
    expect((await ask([a.sourceId])).map((hit) => hit.sourceName)).toEqual(["A"]);
    expect((await ask([b.sourceId])).map((hit) => hit.sourceName)).toEqual(["B"]);
    expect(new Set((await ask([a.sourceId, b.sourceId])).map((hit) => hit.sourceName))).toEqual(new Set(["A", "B"]));
    expect(await ask([])).toEqual([]);
  });
});

describe("agente e bases", () => {
  it("um agente usa várias bases, uma base serve vários agentes, e o modo vale por agente", async () => {
    const org = await createOrganization(app, "kb agents");
    const one = await withOrg(app, org, (q) => indexed(q, "Preços", "# Preços\n\nA consulta custa cento e cinquenta reais."));
    const two = await withOrg(app, org, (q) => indexed(q, "Horários", "# Horários\n\nAtendemos de segunda a sexta."));
    const queued = await withOrg(app, org, (q) => createKnowledgeSource(q, { name: "Ainda indexando", kind: "text", text: "Texto novo", createdBy: null, now }));
    const nico = await createAgent(org, "Nico");
    const maya = await createAgent(org, "Maya");
    await withOrg(app, org, async (q) => {
      expect(await setAgentKnowledge(q, nico, { sourceIds: [one.sourceId, two.sourceId, queued.sourceId], mode: "rag", only: true }, now)).toBe(true);
      expect(await setAgentKnowledge(q, maya, { sourceIds: [one.sourceId], mode: "auto", only: false }, now)).toBe(true);
    });
    const nicoKb = await withOrg(app, org, (q) => getAgentKnowledge(q, nico));
    expect(nicoKb).toMatchObject({ mode: "rag", only: true });
    // A fonte ainda sem versão pronta fica vinculada, mas não responde.
    expect(nicoKb?.sources.map((source) => source.name)).toEqual(["Horários", "Preços"]);
    expect(nicoKb?.linkedIds).toHaveLength(3);
    expect((await withOrg(app, org, (q) => getAgentKnowledge(q, maya)))?.sources.map((source) => source.name)).toEqual(["Preços"]);
    expect((await withOrg(app, org, (q) => getKnowledgeSource(q, one.sourceId)))?.agentCount).toBe(2);

    // Trocar a lista tira o que saiu e mantém o resto.
    await withOrg(app, org, (q) => setAgentKnowledge(q, nico, { sourceIds: [two.sourceId], mode: "full", only: false }, later));
    expect(await withOrg(app, org, (q) => getAgentKnowledge(q, nico))).toMatchObject({ mode: "full", only: false, linkedIds: [two.sourceId] });
    expect(await withOrg(app, org, (q) => setAgentKnowledge(q, "00000000-0000-4000-8000-000000000000", { sourceIds: [], mode: "auto", only: false }, now))).toBe(false);
    expect(await withOrg(app, org, (q) => getAgentKnowledge(q, "00000000-0000-4000-8000-000000000000"))).toBeNull();
  });

  it("escolhe o modo `auto` pelo tamanho", () => {
    expect(resolveKnowledgeMode("auto", FULL_PROMPT_MAX_TOKENS)).toBe("full");
    expect(resolveKnowledgeMode("auto", FULL_PROMPT_MAX_TOKENS + 1)).toBe("rag");
    expect(resolveKnowledgeMode("rag", 10)).toBe("rag");
    expect(resolveKnowledgeMode("full", 10_000_000)).toBe("full");
  });
});
