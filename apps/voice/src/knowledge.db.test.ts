// A base de conhecimento do agente no começo da ligação: sem base nada muda; com base, o prompt e o evento certos.
import { encryptSecret, chunkText, claimKnowledgeVersion, completeKnowledgeVersion, createKnowledgeSource, setAgentKnowledge, withOrg, withSystem, type KnowledgeMode, type OrgQuery } from "@ozavo/core";
import { autoCommitOrgQuery } from "@ozavo/tools";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openTestDbs } from "../../../packages/core/test/helpers";
import { fakeEmbedding } from "../../../packages/core/test/fake-embeddings";
import { putSetting } from "../../../packages/tools/test/helpers";
import { startCallSession } from "./call-session";
import { prepareCallKnowledge } from "./knowledge";
import { createAgent, createCall, createOrganization, eventsOf, manualEngine, manualTransport, secretKey, sessionHarness, type ManualEngine, type SessionHarness } from "./testing/db";
import { waitFor } from "./testing/helpers";

const { app, owner } = openTestDbs();
let harness: SessionHarness | undefined;
afterEach(async () => {
  await harness?.approvals.close();
  harness = undefined;
});
afterAll(async () => {
  await app.close();
  await owner.close();
});

const now = new Date("2031-03-01T09:00:00Z");
const MANUAL = [
  "# Preços",
  "A limpeza custa cento e oitenta reais. O clareamento a laser custa mil e duzentos reais em três sessões.",
  "# Horários",
  "A clínica atende de segunda a sexta, das oito às dezoito horas.",
].join("\n\n");

async function indexed(organizationId: string, name: string, text: string): Promise<string> {
  return withOrg(app, organizationId, async (q: OrgQuery) => {
    const created = await createKnowledgeSource(q, { name, kind: "text", text, createdBy: null, now });
    const claimed = await claimKnowledgeVersion(q, created.versionId, now);
    if (!claimed) throw new Error("not claimed");
    const chunks = chunkText(text);
    await completeKnowledgeVersion(q, {
      versionId: created.versionId,
      sourceId: created.sourceId,
      text,
      chunks: chunks.map((chunk) => ({ ...chunk, embedding: fakeEmbedding(chunk.content) })),
      tokenCount: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
      embeddingTokens: 50,
      costMicrocents: 1000,
      now,
    });
    return created.sourceId;
  });
}

async function scene(label: string, options: { mode?: KnowledgeMode; only?: boolean; sources?: Array<{ name: string; text: string }>; retrieves?: boolean } = {}) {
  const organizationId = await createOrganization(app, label);
  const agentId = await createAgent(app, organizationId, { engine: "manual", instructions: "Você é a recepção da clínica." });
  const sourceIds: string[] = [];
  for (const source of options.sources ?? []) sourceIds.push(await indexed(organizationId, source.name, source.text));
  if (sourceIds.length > 0 || options.mode) await withOrg(app, organizationId, (q) => setAgentKnowledge(q, agentId, { sourceIds, mode: options.mode ?? "auto", only: options.only ?? false }, now));
  const manual: ManualEngine = manualEngine();
  if (options.retrieves) manual.engine.retrievesKnowledge = true;
  await putSetting(app, organizationId, "engine.manual.api_key", encryptSecret("sk-teste", secretKey));
  await harness?.approvals.close();
  harness = await sessionHarness(app, [manual.engine]);
  const run = async (during?: (callId: string) => Promise<void>) => {
    const callId = await createCall(app, organizationId, agentId, (harness as SessionHarness).clock.now(), "inbound");
    const transport = manualTransport();
    const session = startCallSession((harness as SessionHarness).deps, { organizationId, callId, agentId, transport });
    await waitFor(async () => manual.configs.length > 0 && (await eventsOf(app, callId)).some((event) => event.kind === "call_answered"), "the call to be answered");
    await during?.(callId);
    transport.callerHangup();
    await session.done;
    return { callId, config: manual.configs.at(-1), events: await eventsOf(app, callId) };
  };
  return { organizationId, agentId, sourceIds, manual, run };
}

describe("agente sem base de conhecimento", () => {
  it("o prompt, a configuração do motor e a linha do tempo são os de sempre", async () => {
    const s = await scene("kb voz sem base");
    const { config, events } = await s.run();
    expect(config?.instructions).toBe("Você é a recepção da clínica.");
    expect(config?.knowledge).toBeUndefined();
    expect(events.map((event) => event.kind)).not.toContain("knowledge_loaded");
  });

  it("base ainda sem versão pronta (na fila) também não muda nada", async () => {
    const s = await scene("kb voz so na fila");
    await withOrg(app, s.organizationId, async (q) => {
      const created = await createKnowledgeSource(q, { name: "Manual", kind: "text", text: MANUAL, createdBy: null, now });
      await setAgentKnowledge(q, s.agentId, { sourceIds: [created.sourceId], mode: "auto", only: false }, now);
    });
    const { config, events } = await s.run();
    expect(config?.instructions).toBe("Você é a recepção da clínica.");
    expect(config?.knowledge).toBeUndefined();
    expect(events.map((event) => event.kind)).not.toContain("knowledge_loaded");
  });
});

describe("modo base inteira", () => {
  it("monta o prompt com a base numa seção fixa, idêntica entre ligações do mesmo agente, e registra o carregamento", async () => {
    const s = await scene("kb voz full", { sources: [{ name: "Manual", text: MANUAL }, { name: "Convênios", text: "Aceitamos Unimed e Bradesco Saúde." }] });
    const first = await s.run();
    const second = await s.run();
    expect(first.config?.instructions).toContain("Você é a recepção da clínica.");
    expect(first.config?.instructions).toContain("### Convênios\nAceitamos Unimed e Bradesco Saúde.");
    expect(first.config?.instructions).toContain("### Manual");
    // ordem determinística por nome, sem nada que mude entre ligações
    expect((first.config?.instructions ?? "").indexOf("### Convênios")).toBeLessThan((first.config?.instructions ?? "").indexOf("### Manual"));
    expect(second.config?.instructions).toBe(first.config?.instructions);
    expect(first.config?.knowledge).toEqual({ mode: "full", only: false });
    const loaded = first.events.find((event) => event.kind === "knowledge_loaded");
    expect(loaded?.payload).toMatchObject({ mode: "full", configuredMode: "auto", sources: 2, tokens: expect.any(Number) });
    expect(JSON.stringify(loaded?.payload)).not.toContain("Unimed");
    // a seção vem antes do contexto da ligação, que muda a cada chamada (aqui não há, mas a ordem do compositor é a que vale)
  });

  it("'responder só pela base' entra na instrução", async () => {
    const s = await scene("kb voz only", { sources: [{ name: "Manual", text: MANUAL }], only: true });
    const { config } = await s.run();
    expect(config?.instructions).toMatch(/Responda apenas com o que está na base/);
    expect(config?.knowledge).toEqual({ mode: "full", only: true });
  });
});

describe("modo de busca", () => {
  it("só a instrução vai ao prompt, e a busca da ligação enxerga só as bases do agente da organização", async () => {
    const s = await scene("kb voz rag", { mode: "rag", sources: [{ name: "Manual", text: MANUAL }], retrieves: true });
    // outra empresa com um texto que só ela tem
    const other = await createOrganization(app, "kb voz rag outra");
    await indexed(other, "Segredo", "O código do cofre da outra empresa é banana prateada.");
    const { config, events } = await s.run();
    expect(config?.instructions).not.toContain("cento e oitenta");
    expect(config?.instructions).toMatch(/trechos/);
    expect(config?.knowledge).toMatchObject({ mode: "rag", only: false });
    const search = config?.knowledge?.search;
    if (!search) throw new Error("sem busca");
    const hits = await search({ question: "quanto custa a limpeza", embedding: null, k: 3 });
    expect(hits[0]).toMatchObject({ sourceName: "Manual", section: "Preços" });
    expect(hits[0]?.content).toContain("cento e oitenta");
    const hybrid = await search({ question: "quanto custa a limpeza", embedding: fakeEmbedding("A limpeza custa cento e oitenta reais"), k: 3 });
    expect(hybrid.length).toBeGreaterThan(0);
    expect(await search({ question: "banana prateada cofre", embedding: null, k: 3 })).toEqual([]);
    expect(events.find((event) => event.kind === "knowledge_loaded")?.payload).toMatchObject({ mode: "rag", configuredMode: "rag", sources: 1 });
  });

  it("modo auto: base grande demais para o prompt vira busca", async () => {
    const s = await scene("kb voz auto grande", { sources: [{ name: "Manual", text: MANUAL }], retrieves: true });
    await withSystem(app, (q) => q.exec("update knowledge_sources set token_count = $2 where organization_id = $1", [s.organizationId, 20000]));
    const { config, events } = await s.run();
    expect(config?.knowledge?.mode).toBe("rag");
    expect(events.find((event) => event.kind === "knowledge_loaded")?.payload).toMatchObject({ mode: "rag", configuredMode: "auto" });
  });

  it("motor de voz direta (sem busca): base pequena vai inteira no prompt", async () => {
    const s = await scene("kb voz direto pequeno", { mode: "rag", sources: [{ name: "Manual", text: MANUAL }], retrieves: false });
    const { config, events } = await s.run();
    expect(config?.knowledge).toEqual({ mode: "full", only: false });
    expect(config?.instructions).toContain("A limpeza custa cento e oitenta reais");
    expect(events.find((event) => event.kind === "knowledge_loaded")?.payload).toMatchObject({ mode: "full", configuredMode: "rag" });
  });

  it("motor de voz direta com base grande demais: segue sem a base e o motivo fica na linha do tempo", async () => {
    const s = await scene("kb voz direto grande", { mode: "rag", sources: [{ name: "Manual", text: MANUAL }], retrieves: false });
    await withSystem(app, (q) => q.exec("update knowledge_sources set token_count = $2 where organization_id = $1", [s.organizationId, 80000]));
    const { config, events } = await s.run();
    expect(config?.knowledge).toBeUndefined();
    expect(config?.instructions).toBe("Você é a recepção da clínica.");
    expect(events.find((event) => event.kind === "knowledge_loaded")?.payload).toMatchObject({ configuredMode: "rag", fallback: "engine_unsupported" });
  });
});

describe("auditoria do turno", () => {
  it("o que a busca fez num turno vai à linha do tempo dentro do llm_call, sem o texto da conversa nem dos trechos", async () => {
    const s = await scene("kb voz auditoria", { mode: "rag", sources: [{ name: "Manual", text: MANUAL }], retrieves: true });
    const knowledge = { mode: "rag" as const, hits: [{ chunkId: "c1", sourceId: s.sourceIds[0] ?? "", sourceName: "Manual", position: 0, section: "Preços", score: 0.0328, vectorScore: 0.61 }], retrievalMs: 0, speculative: true, usedVector: true, embeddingTokens: 9 };
    const { events } = await s.run(async (callId) => {
      s.manual.emit("llmCall", { promptTokens: 2000, cachedTokens: 1500, completionTokens: 20, knowledge });
      await waitFor(async () => (await eventsOf(app, callId)).some((event) => event.kind === "llm_call"), "the llm call to be recorded");
    });
    const call = events.find((event) => event.kind === "llm_call");
    expect(call?.payload).toMatchObject({ promptTokens: 2000, knowledge: { mode: "rag", speculative: true, usedVector: true, embeddingTokens: 9, hits: [{ section: "Preços", score: 0.0328 }] } });
  });
});

describe("falha ao carregar", () => {
  it("o erro do banco não derruba a ligação: segue sem a base, registra o motivo e loga", async () => {
    const logs: string[] = [];
    const broken: OrgQuery = {
      organizationId: "x",
      many: () => Promise.reject(new Error("conexão caiu")),
      one: () => Promise.reject(new Error("conexão caiu")),
      exec: () => Promise.reject(new Error("conexão caiu")),
    };
    const result = await prepareCallKnowledge({ orgQuery: () => broken, agentId: "a", language: "pt-BR", supportsRetrieval: true, now: () => 0, log: (_level, message) => void logs.push(message) });
    expect(result).toMatchObject({ kind: "unavailable", payload: { fallback: "load_failed" } });
    expect(logs).toEqual([expect.stringContaining("without it")]);
  });

  it("agente que não existe não tem base", async () => {
    const organizationId = await createOrganization(app, "kb voz sem agente");
    const result = await prepareCallKnowledge({
      orgQuery: () => autoCommitOrgQuery(app, organizationId),
      agentId: "00000000-0000-0000-0000-000000000000",
      language: "pt-BR",
      supportsRetrieval: true,
      now: () => 0,
      log: () => undefined,
    });
    expect(result).toEqual({ kind: "none" });
  });
});
