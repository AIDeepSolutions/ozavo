import {
  KNOWLEDGE_LIMITS,
  chunkText,
  claimKnowledgeVersion,
  completeKnowledgeVersion,
  encryptSecret,
  withOrg,
  type OrgQuery,
} from "@ozavo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeEmbeddingsFetch, fakeEmbedding } from "../../../../../../packages/core/test/fake-embeddings";
import { SECRET_KEY, call, createOrganization, createUser, insert, startPanel, type Result } from "../../../../test/kit";
import { PUT as setAgentBases, GET as getAgentBases } from "./agents/[id]/knowledge/route";
import { DELETE as removeSource, GET as getSource, PATCH as renameSource } from "./knowledge/[id]/route";
import { POST as reindex } from "./knowledge/[id]/reindex/route";
import { POST as replace } from "./knowledge/[id]/replace/route";
import { GET as listSources, POST as createSource } from "./knowledge/route";
import { POST as search } from "./knowledge/search/route";
import { GET as usage } from "./knowledge/usage/route";

const panel = startPanel();
let orgA: string;
let orgB: string;
let ownerA: Awaited<ReturnType<typeof createUser>>;
let adminA: Awaited<ReturnType<typeof createUser>>;
let operatorA: Awaited<ReturnType<typeof createUser>>;
let ownerB: Awaited<ReturnType<typeof createUser>>;
let agentA: string;
let agentB: string;

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n", "latin1");
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("fake docx body")]);
const TEXT = "# Horários\n\nA clínica atende de segunda a sexta, das oito às dezoito horas.\n\n# Preços\n\nA consulta de avaliação custa cento e cinquenta reais.";

/** Envia um arquivo como o navegador envia: `multipart/form-data`. */
async function upload(handler: (request: Request, context: { params: Promise<Record<string, string> | undefined> }) => Promise<Response>, input: { cookie?: string; file?: { name: string; bytes: Buffer | Uint8Array }; name?: string; params?: Record<string, string>; headers?: Record<string, string> }): Promise<Result> {
  const form = new FormData();
  if (input.file) form.set("file", new File([new Uint8Array(input.file.bytes)], input.file.name));
  if (input.name !== undefined) form.set("name", input.name);
  const response = await handler(new Request("https://panel.test/api/v1/x", { method: "POST", headers: { ...(input.cookie && { cookie: input.cookie }), ...input.headers }, body: form }), { params: Promise.resolve(input.params) });
  const text = await response.text();
  const json = JSON.parse(text) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  return { status: response.status, ok: json.ok, data: json.data, code: json.error?.code, message: json.error?.message, text, headers: response.headers };
}

const paste = (cookie: string, name: string, text = TEXT): Promise<Result> => call(createSource, { method: "POST", cookie, body: { name, text } });
const newSource = async (cookie: string, name: string, text = TEXT): Promise<string> => {
  const created = await paste(cookie, name, text);
  expect(created.status).toBe(200);
  return (created.data as { sourceId: string }).sourceId;
};

/** Deixa a fonte pronta como a rotina deixaria, com embeddings falsos. */
async function makeReady(org: string, sourceId: string, text = TEXT): Promise<void> {
  await withOrg(panel.app, org, async (q: OrgQuery) => {
    const version = await q.one<{ id: string }>("select id from knowledge_versions where source_id = $1 order by version desc limit 1", [sourceId]);
    const claimed = await claimKnowledgeVersion(q, version?.id ?? "", panel.deps.clock.now());
    if (!claimed) throw new Error("not claimed");
    const chunks = chunkText(text);
    await completeKnowledgeVersion(q, {
      versionId: claimed.versionId,
      sourceId,
      text,
      chunks: chunks.map((chunk) => ({ ...chunk, embedding: fakeEmbedding(chunk.content) })),
      tokenCount: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
      embeddingTokens: 120,
      costMicrocents: 2400,
      now: panel.deps.clock.now(),
    });
  });
}

const events = (org: string, kind: string): Promise<Array<{ payload: Record<string, unknown>; actor_user_id: string | null }>> =>
  withOrg(panel.app, org, (q) => q.many("select payload, actor_user_id from organization_events where kind = $1 order by id", [kind]));

beforeAll(async () => {
  orgA = await createOrganization(panel.app, "kb screen A");
  orgB = await createOrganization(panel.app, "kb screen B");
  ownerA = await createUser(panel.app, orgA, "owner");
  adminA = await createUser(panel.app, orgA, "admin");
  operatorA = await createUser(panel.app, orgA, "operator");
  ownerB = await createUser(panel.app, orgB, "owner");
  agentA = await insert(panel.app, orgA, "insert into agents (organization_id, name, engine) values ($1, 'Nico', 'simulated') returning id", [orgA]);
  agentB = await insert(panel.app, orgB, "insert into agents (organization_id, name, engine) values ($1, 'Bia', 'simulated') returning id", [orgB]);
});
afterAll(() => panel.close());

describe("base de conhecimento: criar", () => {
  it("texto colado entra na fila com a versão 1, a tarefa de indexação e o rastro na empresa", async () => {
    const created = await paste(ownerA.cookie, "  Horários e preços  ");
    expect(created.status).toBe(200);
    const { sourceId, versionId } = created.data as { sourceId: string; versionId: string };

    const listed = await call(listSources, { cookie: ownerA.cookie });
    expect(listed.data).toMatchObject({ sources: [expect.objectContaining({ id: sourceId, name: "Horários e preços", kind: "text", status: "queued", latestVersion: 1, agentCount: 0, chunkCount: 0 })] });
    const one = await call(getSource, { cookie: ownerA.cookie, params: { id: sourceId } });
    expect(one.data).toMatchObject({ id: sourceId, status: "queued", originalFilename: null });

    const tasks = await withOrg(panel.app, orgA, (q) => q.many<{ payload: { versionId: string } }>("select payload from tasks where kind = 'index_knowledge'"));
    expect(tasks.map((task) => task.payload.versionId)).toContain(versionId);

    const [event] = await events(orgA, "knowledge_source_created");
    expect(event?.payload).toMatchObject({ sourceId, name: "Horários e preços", kind: "text" });
    expect(event?.actor_user_id).toBe(ownerA.id);
    // O texto do documento nunca vai para o rastro.
    expect(JSON.stringify(event)).not.toContain("clínica atende");
  });

  it("aceita PDF, DOCX, Markdown e texto pelo conteúdo e pelo nome; o nome do arquivo vira o nome da base", async () => {
    const send = (name: string, bytes: Buffer, given?: string) => upload(createSource, { cookie: adminA.cookie, file: { name, bytes }, name: given });
    const pdf = await send("Tabela de preços.pdf", PDF);
    const docx = await send("Manual.DOCX", ZIP);
    const md = await send("faq.md", Buffer.from("# Perguntas\n\nQuanto custa?"));
    const txt = await send("avisos.txt", Buffer.from("Fechamos no feriado."), "  Avisos da recepção ");
    for (const result of [pdf, docx, md, txt]) expect(result.status).toBe(200);
    const listed = (await call(listSources, { cookie: adminA.cookie })).data as { sources: Array<{ name: string; kind: string; originalFilename: string | null; sizeBytes: number }> };
    const byName = new Map(listed.sources.map((source) => [source.name, source]));
    expect(byName.get("Tabela de preços")).toMatchObject({ kind: "pdf", originalFilename: "Tabela de preços.pdf", sizeBytes: PDF.length });
    expect(byName.get("Manual")).toMatchObject({ kind: "docx" });
    expect(byName.get("faq")).toMatchObject({ kind: "md" });
    expect(byName.get("Avisos da recepção")).toMatchObject({ kind: "txt", originalFilename: "avisos.txt" });
  });

  it("recusa tipo falso: o nome diz uma coisa e os bytes outra, ou uma extensão que não aceitamos", async () => {
    const attempt = async (name: string, bytes: Buffer): Promise<[number, string | undefined]> => {
      const result = await upload(createSource, { cookie: ownerA.cookie, file: { name, bytes } });
      return [result.status, result.code];
    };
    expect(await attempt("falso.pdf", Buffer.from("isto é só texto"))).toEqual([415, "knowledge_unsupported_type"]);
    expect(await attempt("falso.docx", PDF)).toEqual([415, "knowledge_unsupported_type"]);
    expect(await attempt("falso.docx", Buffer.from("não é um zip"))).toEqual([415, "knowledge_unsupported_type"]);
    expect(await attempt("falso.txt", PDF)).toEqual([415, "knowledge_unsupported_type"]);
    expect(await attempt("falso.md", ZIP)).toEqual([415, "knowledge_unsupported_type"]);
    expect(await attempt("binario.txt", Buffer.from([0x68, 0x69, 0x00, 0x01]))).toEqual([415, "knowledge_unsupported_type"]);
    expect(await attempt("programa.exe", Buffer.from("MZ"))).toEqual([415, "knowledge_unsupported_type"]);
    expect(await attempt("semextensao", Buffer.from("texto"))).toEqual([415, "knowledge_unsupported_type"]);
    const before = (await call(listSources, { cookie: ownerA.cookie })).data as { sources: unknown[] };
    expect(before.sources.length).toBeGreaterThan(0);
  });

  it("recusa vazio, tamanho acima do teto (pelo arquivo e pelo cabeçalho) e texto grande demais, com a frase do limite", async () => {
    const empty = await upload(createSource, { cookie: ownerA.cookie, file: { name: "vazio.txt", bytes: Buffer.alloc(0) } });
    expect([empty.status, empty.code]).toEqual([422, "knowledge_empty"]);

    const big = await upload(createSource, { cookie: ownerA.cookie, file: { name: "grande.pdf", bytes: Buffer.concat([PDF, Buffer.alloc(KNOWLEDGE_LIMITS.maxFileBytes)]) } });
    expect([big.status, big.code]).toEqual([413, "knowledge_file_too_large"]);
    expect(big.message).toContain("20 MB");

    // O cabeçalho já diz que passa: a rota recusa antes de ler o corpo.
    const declared = await upload(createSource, { cookie: ownerA.cookie, file: { name: "x.txt", bytes: Buffer.from("x") }, headers: { "content-length": String(KNOWLEDGE_LIMITS.maxFileBytes * 2) } });
    expect([declared.status, declared.code]).toEqual([413, "knowledge_file_too_large"]);

    expect((await paste(ownerA.cookie, "Vazio", "   \n ")).code).toBe("knowledge_empty");
    const longText = await paste(ownerA.cookie, "Enorme", "a".repeat(KNOWLEDGE_LIMITS.maxTextCharacters + 1));
    expect([longText.status, longText.code]).toEqual([413, "knowledge_text_too_large"]);
    expect((await call(createSource, { method: "POST", cookie: ownerA.cookie, body: { name: "x".repeat(201), text: "oi" } })).status).toBe(400);
    expect((await call(createSource, { method: "POST", cookie: ownerA.cookie, body: { text: "sem nome" } })).code).toBe("knowledge_name");
    const noFile = await upload(createSource, { cookie: ownerA.cookie });
    expect([noFile.status, noFile.code]).toEqual([400, "validation_error"]);
    const wrongType = await call(createSource, { method: "POST", cookie: ownerA.cookie, headers: { "content-type": "text/plain" } });
    expect([wrongType.status, wrongType.code]).toEqual([415, "knowledge_unsupported_type"]);
  });

  it("respeita o teto de fontes e o de tokens da empresa", async () => {
    const org = await createOrganization(panel.app, "kb limits");
    const owner = await createUser(panel.app, org, "owner");
    await withOrg(panel.app, org, (q) =>
      q.exec(
        `insert into knowledge_sources (organization_id, name, kind, status, token_count, embedding_model, created_at, updated_at)
         select $1, 'f' || n, 'text', 'ready', 0, 'm', now(), now() from generate_series(1, $2) n`,
        [org, KNOWLEDGE_LIMITS.maxSources],
      ),
    );
    const tooMany = await paste(owner.cookie, "mais uma");
    expect([tooMany.status, tooMany.code]).toEqual([409, "knowledge_too_many_sources"]);

    await withOrg(panel.app, org, async (q) => {
      await q.exec("delete from knowledge_sources where name <> 'f1'");
      await q.exec("update knowledge_sources set token_count = $1", [KNOWLEDGE_LIMITS.maxOrganizationTokens - 10]);
    });
    const over = await paste(owner.cookie, "estoura", "palavra ".repeat(400));
    expect([over.status, over.code]).toEqual([409, "knowledge_organization_quota"]);
  });
});

describe("base de conhecimento: papéis e isolamento", () => {
  it("operador lê a lista, o uso e o vínculo do agente; todo o resto é 403, e sem sessão é 401", async () => {
    const id = await newSource(ownerA.cookie, "Para o operador");
    expect((await call(listSources, { cookie: operatorA.cookie })).status).toBe(200);
    expect((await call(usage, { cookie: operatorA.cookie })).status).toBe(200);
    expect((await call(getSource, { cookie: operatorA.cookie, params: { id } })).status).toBe(200);
    expect((await call(getAgentBases, { cookie: operatorA.cookie, params: { id: agentA } })).status).toBe(200);
    for (const [handler, options] of [
      [createSource, { method: "POST", body: { name: "x", text: "y" } }],
      [renameSource, { method: "PATCH", params: { id }, body: { name: "novo" } }],
      [removeSource, { method: "DELETE", params: { id } }],
      [reindex, { method: "POST", params: { id } }],
      [replace, { method: "POST", params: { id }, body: { text: "novo" } }],
      [search, { method: "POST", body: { question: "preço" } }],
      [setAgentBases, { method: "PUT", params: { id: agentA }, body: { sourceIds: [id], mode: "rag", only: false } }],
    ] as const) {
      const result = await call(handler, { ...options, cookie: operatorA.cookie });
      expect([result.status, result.code]).toEqual([403, "forbidden"]);
    }
    expect((await call(listSources, {})).status).toBe(401);
    expect((await call(createSource, { method: "POST", body: { name: "x", text: "y" } })).status).toBe(401);
    // Nada mudou por causa do operador.
    expect((await call(getSource, { cookie: ownerA.cookie, params: { id } })).data).toMatchObject({ name: "Para o operador" });
  });

  it("isolamento A × B: a outra empresa não vê, renomeia, reindexa, troca, apaga, busca nem vincula", async () => {
    const id = await newSource(ownerA.cookie, "Só da empresa A", "O código do cofre da empresa A é laranja.");
    await makeReady(orgA, id, "O código do cofre da empresa A é laranja.");
    expect(((await call(listSources, { cookie: ownerB.cookie })).data as { sources: unknown[] }).sources).toEqual([]);
    expect((await call(getSource, { cookie: ownerB.cookie, params: { id } })).code).toBe("not_found");
    for (const [handler, options] of [
      [renameSource, { method: "PATCH", body: { name: "roubada" } }],
      [removeSource, { method: "DELETE" }],
      [reindex, { method: "POST" }],
      [replace, { method: "POST", body: { text: "troca" } }],
    ] as const) {
      const result = await call(handler, { ...options, cookie: ownerB.cookie, params: { id } });
      expect([result.status, result.code]).toEqual([404, "not_found"]);
    }
    // Vincular a base de A ao agente de B: a fonte nem é vista.
    const link = await call(setAgentBases, { method: "PUT", cookie: ownerB.cookie, params: { id: agentB }, body: { sourceIds: [id], mode: "auto", only: false } });
    expect([link.status, link.code]).toEqual([404, "not_found"]);
    // E o agente de A não é de B.
    expect((await call(getAgentBases, { cookie: ownerB.cookie, params: { id: agentA } })).code).toBe("not_found");
    expect((await call(setAgentBases, { method: "PUT", cookie: ownerB.cookie, params: { id: agentA }, body: { sourceIds: [], mode: "auto", only: false } })).code).toBe("not_found");
    // A fonte segue intacta.
    expect((await call(getSource, { cookie: ownerA.cookie, params: { id } })).data).toMatchObject({ name: "Só da empresa A", status: "ready" });
    expect((await call(usage, { cookie: ownerB.cookie })).data).toMatchObject({ tokens: 0, sources: 0 });
  });
});

describe("base de conhecimento: renomear, reindexar, substituir e apagar", () => {
  it("renomear muda só o nome e deixa o rastro; nome vazio ou grande é recusado", async () => {
    const id = await newSource(ownerA.cookie, "Antes");
    const renamed = await call(renameSource, { method: "PATCH", cookie: adminA.cookie, params: { id }, body: { name: "  Depois  " } });
    expect(renamed.data).toMatchObject({ id, name: "Depois", status: "queued" });
    expect((await call(renameSource, { method: "PATCH", cookie: ownerA.cookie, params: { id }, body: { name: "   " } })).status).toBe(400);
    expect((await call(renameSource, { method: "PATCH", cookie: ownerA.cookie, params: { id }, body: { name: "x".repeat(201) } })).status).toBe(400);
    const changed = await events(orgA, "knowledge_source_changed");
    expect(changed.map((row) => row.payload)).toContainEqual(expect.objectContaining({ sourceId: id, change: "renamed", name: "Depois" }));
  });

  it("reindexar usa o texto já extraído: sem texto é 422; com texto cria a versão 2 e a fonte atual continua respondendo", async () => {
    const fromFile = await upload(createSource, { cookie: ownerA.cookie, file: { name: "sem-texto.pdf", bytes: PDF } });
    const rawOnly = (fromFile.data as { sourceId: string }).sourceId;
    const nothing = await call(reindex, { method: "POST", cookie: ownerA.cookie, params: { id: rawOnly } });
    expect([nothing.status, nothing.code]).toEqual([422, "knowledge_no_text"]);

    const id = await newSource(ownerA.cookie, "Reindexável");
    await makeReady(orgA, id);
    const before = (await call(getSource, { cookie: ownerA.cookie, params: { id } })).data as { currentVersionId: string; chunkCount: number };
    expect(before.chunkCount).toBeGreaterThan(0);

    const again = await call(reindex, { method: "POST", cookie: ownerA.cookie, params: { id } });
    expect(again.status).toBe(200);
    const after = (await call(getSource, { cookie: ownerA.cookie, params: { id } })).data as { status: string; latestVersion: number; currentVersionId: string; chunkCount: number };
    expect(after).toMatchObject({ status: "queued", latestVersion: 2, currentVersionId: before.currentVersionId, chunkCount: before.chunkCount });
    expect((await events(orgA, "knowledge_source_reindexed")).map((row) => row.payload)).toContainEqual(expect.objectContaining({ sourceId: id }));
  });

  it("substituir por arquivo ou texto cria a versão nova na fila, confere o tipo e deixa a anterior valendo", async () => {
    const id = await newSource(ownerA.cookie, "Substituível");
    await makeReady(orgA, id);
    const current = ((await call(getSource, { cookie: ownerA.cookie, params: { id } })).data as { currentVersionId: string }).currentVersionId;

    const fake = await upload(replace, { cookie: ownerA.cookie, params: { id }, file: { name: "novo.pdf", bytes: Buffer.from("não é pdf") } });
    expect([fake.status, fake.code]).toEqual([415, "knowledge_unsupported_type"]);

    const sent = await upload(replace, { cookie: ownerA.cookie, params: { id }, file: { name: "tabela-nova.pdf", bytes: PDF } });
    expect(sent.status).toBe(200);
    const afterFile = (await call(getSource, { cookie: ownerA.cookie, params: { id } })).data as { status: string; kind: string; originalFilename: string; latestVersion: number; currentVersionId: string; name: string };
    expect(afterFile).toMatchObject({ status: "queued", kind: "pdf", originalFilename: "tabela-nova.pdf", latestVersion: 2, currentVersionId: current, name: "Substituível" });

    const pasted = await call(replace, { method: "POST", cookie: ownerA.cookie, params: { id }, body: { text: "Texto novo da base." } });
    expect(pasted.status).toBe(200);
    expect((await call(getSource, { cookie: ownerA.cookie, params: { id } })).data).toMatchObject({ kind: "text", latestVersion: 3 });
    expect((await call(replace, { method: "POST", cookie: ownerA.cookie, params: { id }, body: { text: "  " } })).code).toBe("knowledge_empty");
    expect((await events(orgA, "knowledge_source_changed")).filter((row) => row.payload.sourceId === id && row.payload.change === "replaced")).toHaveLength(2);
  });

  it("apagar remove a fonte, os trechos e o vínculo com os agentes, e diz quantos agentes a usavam; o custo fica no registro de uso", async () => {
    const id = await newSource(ownerA.cookie, "Para apagar");
    await makeReady(orgA, id);
    const link = await call(setAgentBases, { method: "PUT", cookie: ownerA.cookie, params: { id: agentA }, body: { sourceIds: [id], mode: "rag", only: true } });
    expect(link.status).toBe(200);
    expect(((await call(listSources, { cookie: ownerA.cookie })).data as { sources: Array<{ id: string; agentCount: number }> }).sources.find((source) => source.id === id)?.agentCount).toBe(1);

    const removed = await call(removeSource, { method: "DELETE", cookie: ownerA.cookie, params: { id } });
    expect(removed.data).toEqual({ removed: true, agentCount: 1 });
    expect((await call(removeSource, { method: "DELETE", cookie: ownerA.cookie, params: { id } })).status).toBe(404);
    expect((await call(getSource, { cookie: ownerA.cookie, params: { id } })).status).toBe(404);
    const left = await withOrg(panel.app, orgA, async (q) => ({
      chunks: await q.one<{ n: number }>("select count(*)::int as n from knowledge_chunks where source_id = $1", [id]),
      links: await q.one<{ n: number }>("select count(*)::int as n from agent_knowledge_sources where source_id = $1", [id]),
      usage: await q.one<{ n: number }>("select count(*)::int as n from knowledge_usage where kind = 'index' and source_id is null", []),
    }));
    expect(left.chunks?.n).toBe(0);
    expect(left.links?.n).toBe(0);
    expect(left.usage?.n).toBeGreaterThan(0);
    expect((await events(orgA, "knowledge_source_removed")).map((row) => row.payload)).toContainEqual(expect.objectContaining({ sourceId: id, name: "Para apagar", agentCount: 1 }));
    expect((await call(getAgentBases, { cookie: ownerA.cookie, params: { id: agentA } })).data).toMatchObject({ linkedIds: [] });
  });
});

describe("base de conhecimento: o agente", () => {
  it("vincula várias bases, o modo e o 'só pela base'; lista as vinculadas (prontas ou não) e as prontas que respondem", async () => {
    const ready = await newSource(ownerA.cookie, "Pronta");
    await makeReady(orgA, ready);
    const queued = await newSource(ownerA.cookie, "Ainda na fila");
    const saved = await call(setAgentBases, { method: "PUT", cookie: adminA.cookie, params: { id: agentA }, body: { sourceIds: [ready, queued, ready], mode: "full", only: true } });
    expect(saved.data).toMatchObject({ mode: "full", only: true, fullPromptMaxTokens: 6000, linkedIds: expect.arrayContaining([ready, queued]) });
    expect((saved.data as { linkedIds: string[] }).linkedIds).toHaveLength(2);
    expect((saved.data as { sources: Array<{ id: string }> }).sources.map((source) => source.id)).toEqual([ready]);
    expect((await call(getAgentBases, { cookie: operatorA.cookie, params: { id: agentA } })).data).toMatchObject({ mode: "full", only: true });

    const fewer = await call(setAgentBases, { method: "PUT", cookie: ownerA.cookie, params: { id: agentA }, body: { sourceIds: [queued], mode: "auto", only: false } });
    expect(fewer.data).toMatchObject({ mode: "auto", only: false, linkedIds: [queued], sources: [] });
  });

  it("recusa modo desconhecido, id malformado, base inexistente e agente que não existe", async () => {
    const id = await newSource(ownerA.cookie, "Qualquer");
    const put = (agent: string, body: unknown) => call(setAgentBases, { method: "PUT", cookie: ownerA.cookie, params: { id: agent }, body });
    expect((await put(agentA, { sourceIds: [], mode: "turbo", only: false })).status).toBe(400);
    expect((await put(agentA, { sourceIds: ["não-é-uuid"], mode: "rag", only: false })).status).toBe(400);
    expect((await put(agentA, { sourceIds: [id] })).status).toBe(400);
    expect((await put(agentA, { sourceIds: ["00000000-0000-4000-8000-000000000000"], mode: "rag", only: false })).code).toBe("not_found");
    expect((await put("00000000-0000-4000-8000-000000000000", { sourceIds: [], mode: "rag", only: false })).code).toBe("not_found");
    expect((await put("nao-uuid", { sourceIds: [], mode: "rag", only: false })).code).toBe("not_found");
  });
});

describe("base de conhecimento: busca de teste e uso", () => {
  const setKey = (org: string): Promise<string> =>
    insert(panel.app, org, "insert into settings (organization_id, key, value) values ($1, 'engine.deepgram-openrouter-cartesia.api_key', to_jsonb($2::text)) returning key as id", [
      org,
      encryptSecret(JSON.stringify({ deepgram: "dg", cartesia: "ct", openrouter: "or-teste" }), SECRET_KEY),
    ]);

  it("sem a chave do OpenRouter do motor em pipeline, a busca explica em vez de falhar calada", async () => {
    const org = await createOrganization(panel.app, "kb search no key");
    const owner = await createUser(panel.app, org, "owner");
    const result = await call(search, { method: "POST", cookie: owner.cookie, body: { question: "quanto custa a consulta" } });
    expect([result.status, result.code]).toEqual([409, "knowledge_no_embedding_key"]);
  });

  it("embeda a pergunta com a chave da empresa, devolve os trechos com fonte, seção e pontuação e registra o gasto", async () => {
    const org = await createOrganization(panel.app, "kb search");
    const owner = await createUser(panel.app, org, "owner");
    await setKey(org);
    const prices = await newSource(owner.cookie, "Tabela de preços", TEXT);
    await makeReady(org, prices);
    const other = await newSource(owner.cookie, "Política de cancelamento", "# Cancelamento\n\nO cancelamento deve ser avisado com um dia de antecedência pelo telefone.");
    await makeReady(org, other, "# Cancelamento\n\nO cancelamento deve ser avisado com um dia de antecedência pelo telefone.");
    const calls: Array<{ inputs: string[]; authorization: string | null }> = [];
    const previous = panel.voice.respond;
    panel.voice.respond = (url, init) => fakeEmbeddingsFetch(calls)(url, init);
    try {
      const found = await call(search, { method: "POST", cookie: owner.cookie, body: { question: "a consulta de avaliação custa quanto", k: 3 } });
      expect(found.status).toBe(200);
      const data = found.data as { hits: Array<{ sourceId: string; sourceName: string; section: string | null; content: string; vectorScore: number | null; lexicalRank: number | null; score: number }>; ms: number; tokens: number; costMicrocents: number };
      expect(data.hits[0]).toMatchObject({ sourceId: prices, sourceName: "Tabela de preços", section: expect.any(String) });
      expect(data.hits[0]?.content).toContain("cento e cinquenta reais");
      expect(data.hits[0]?.vectorScore).toBeGreaterThan(0.2);
      expect(data.hits[0]?.lexicalRank).toBe(1);
      expect(data.hits.length).toBeLessThanOrEqual(3);
      expect(data.tokens).toBeGreaterThan(0);
      expect(data.costMicrocents).toBeGreaterThan(0);
      expect(typeof data.ms).toBe("number");
      // A chave da empresa foi ao provedor, e só a pergunta foi.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.authorization).toBe("Bearer or-teste");
      expect(calls[0]?.inputs).toEqual(["a consulta de avaliação custa quanto"]);
      expect(found.text).not.toContain("or-teste");

      // Restringir a uma fonte só devolve trechos dela.
      const only = await call(search, { method: "POST", cookie: owner.cookie, body: { question: "cancelamento telefone", sourceIds: [other] } });
      expect((only.data as { hits: Array<{ sourceId: string }> }).hits.every((hit) => hit.sourceId === other)).toBe(true);

      const recorded = await withOrg(panel.app, org, (q) => q.many<{ tokens: number; cost_microcents: string }>("select tokens, cost_microcents::text from knowledge_usage where kind = 'search'"));
      expect(recorded).toHaveLength(2);
      expect(recorded[0]?.tokens).toBe(data.tokens);

      const used = await call(usage, { cookie: owner.cookie });
      expect(used.data).toMatchObject({
        sources: 2,
        limits: { maxFileBytes: KNOWLEDGE_LIMITS.maxFileBytes, maxSourceTokens: 1_000_000, maxOrganizationTokens: 5_000_000, maxSources: 200, fullPromptMaxTokens: 6000 },
        month: { indexTokens: 240, indexCostMicrocents: 4800, searchTokens: expect.any(Number), searchCostMicrocents: expect.any(Number) },
      });
      expect((used.data as { month: { searchTokens: number } }).month.searchTokens).toBe(recorded.reduce((sum, row) => sum + row.tokens, 0));
      expect((used.data as { tokens: number }).tokens).toBeGreaterThan(0);
    } finally {
      panel.voice.respond = previous;
    }
  });

  it("não gasta embedding quando não há fonte pronta, e uma fonte de outra empresa não é buscada", async () => {
    const org = await createOrganization(panel.app, "kb search empty");
    const owner = await createUser(panel.app, org, "owner");
    await setKey(org);
    await newSource(owner.cookie, "Na fila");
    const requests = panel.voice.requests.length;
    const empty = await call(search, { method: "POST", cookie: owner.cookie, body: { question: "qualquer coisa" } });
    expect(empty.data).toEqual({ hits: [], ms: 0, tokens: 0, costMicrocents: 0 });
    expect(panel.voice.requests.length).toBe(requests);

    // Uma fonte de A pedida por B é ignorada (a RLS a esconde): nada volta.
    const secret = await newSource(ownerA.cookie, "Segredo de A", "O código do cofre é laranja.");
    await makeReady(orgA, secret, "O código do cofre é laranja.");
    const previous = panel.voice.respond;
    panel.voice.respond = (url, init) => fakeEmbeddingsFetch()(url, init);
    try {
      const crossed = await call(search, { method: "POST", cookie: owner.cookie, body: { question: "código do cofre laranja", sourceIds: [secret] } });
      expect(crossed.data).toMatchObject({ hits: [] });
    } finally {
      panel.voice.respond = previous;
    }
  });

  it("traduz a falha do provedor: chave recusada e provedor fora do ar viram códigos diferentes", async () => {
    const org = await createOrganization(panel.app, "kb search failing");
    const owner = await createUser(panel.app, org, "owner");
    await setKey(org);
    const id = await newSource(owner.cookie, "Base");
    await makeReady(org, id);
    const previous = panel.voice.respond;
    try {
      panel.voice.respond = () => new Response("{}", { status: 401 });
      const rejected = await call(search, { method: "POST", cookie: owner.cookie, body: { question: "horários de atendimento" } });
      expect([rejected.status, rejected.code]).toEqual([502, "knowledge_embedding_rejected"]);
      panel.voice.respond = () => new Response("{}", { status: 400 });
      expect((await call(search, { method: "POST", cookie: owner.cookie, body: { question: "horários de atendimento" } })).code).toBe("knowledge_embedding_rejected");
    } finally {
      panel.voice.respond = previous;
    }
    expect((await call(search, { method: "POST", cookie: owner.cookie, body: { question: "   " } })).status).toBe(400);
    expect((await call(search, { method: "POST", cookie: owner.cookie, body: { question: "ok", k: 11 } })).status).toBe(400);
  });
});
