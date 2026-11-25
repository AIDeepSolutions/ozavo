import { describe, expect, it } from "vitest";
import { manualClock, until } from "../testing/fake-pipeline";
import type { KnowledgeConfig, KnowledgeSearchHit, LlmCallInfo, Usage, VoiceSessionConfig } from "../types";
import type { TtsHandlers } from "./cartesia-tts";
import type { SttHandlers } from "./deepgram-stt";
import { ENDPOINT_CLOSED_MS } from "./endpointing";
import { RETRIEVAL_BUDGET_MS, SPECULATE_DEBOUNCE_MS, type EmbeddingResult } from "./knowledge-retrieval";
import { chatBody, type ChatMessage } from "./openrouter-llm";
import { createPipelineSession, withKnowledgeContext } from "./session";

const hit = (n: number, content = `Conteúdo secreto ${n}.`): KnowledgeSearchHit => ({ chunkId: `c${n}`, sourceId: "s1", sourceName: "Manual", position: n, section: `Seção ${n}`, content, tokenCount: 40, vectorScore: 0.5, lexicalRank: 1, score: 0.03 });

/** Agendador que dispara por prazo (e não tudo de uma vez): a sessão agenda debounce, fim de turno e orçamento de prazos diferentes. */
function jobsByDelay() {
  const jobs: Array<{ fn: () => void; delayMs: number; cancelled: boolean; done: boolean }> = [];
  return {
    schedule(fn: () => void, delayMs: number): () => void {
      const job = { fn, delayMs, cancelled: false, done: false };
      jobs.push(job);
      return () => {
        job.cancelled = true;
      };
    },
    fire(delayMs: number): void {
      for (const job of jobs) {
        if (job.delayMs !== delayMs || job.cancelled || job.done) continue;
        job.done = true;
        job.fn();
      }
    },
    pending: (delayMs: number) => jobs.filter((job) => job.delayMs === delayMs && !job.cancelled && !job.done).length,
  };
}

async function setup(options: { knowledge?: KnowledgeConfig; embed?: (text: string) => Promise<EmbeddingResult>; config?: Partial<VoiceSessionConfig>; withEmbed?: boolean; toolOnFirstCall?: boolean } = {}) {
  const time = manualClock();
  const timers = jobsByDelay();
  const calls: ChatMessage[][] = [];
  let stt: SttHandlers | undefined;
  let tts: TtsHandlers | undefined;
  const session = await createPipelineSession({
    config: { instructions: "Você é a recepcionista.", language: "pt-BR", tools: [], knowledge: options.knowledge, ...options.config },
    clock: time.clock,
    schedule: timers.schedule,
    ...(options.withEmbed !== false && { embedQuestion: options.embed ?? (async () => ({ vector: [0.1, 0.2, 0.3], tokens: 8, costMicrocents: 160 })) }),
    openStt: async (handlers) => {
      stt = handlers;
      return { sendAudio: () => undefined, finalize: () => undefined, drainSeconds: () => 0, close: async () => undefined };
    },
    openTts: async (handlers) => {
      tts = handlers;
      return { speak: () => undefined, cancel: () => undefined, drainCharacters: () => 0, close: async () => undefined };
    },
    chat: async function* (messages) {
      calls.push([...messages]);
      if (options.toolOnFirstCall && calls.length === 1) yield { type: "tool_call", call: { id: "t1", type: "function", function: { name: "lookup", arguments: "{}" } } };
      else yield { type: "text", delta: "Claro. " };
      yield { type: "usage", usage: { promptTokens: 1000, cachedTokens: 900, completionTokens: 5, costCents: 0.01, model: "m", provider: "p", finishReason: "stop" } };
    },
  });
  const llmCalls: LlmCallInfo[] = [];
  const usages: Usage[] = [];
  session.on("llmCall", (call) => llmCalls.push(call));
  session.on("usage", (usage) => usages.push(usage));
  if (!stt || !tts) throw new Error("portas não abertas");
  const ports = { stt, tts };
  /** Quem ligou diz a frase de uma vez (sem parcial): o fim do turno marca o prazo e o teste o dispara. */
  const callerSays = async (text: string): Promise<void> => {
    const before = calls.length;
    ports.stt.final(text, true);
    timers.fire(ENDPOINT_CLOSED_MS);
    await until(() => calls.length === before + 1);
    await until(() => llmCalls.length >= before + 1);
  };
  return { session, ports, timers, calls, llmCalls, usages, callerSays, time };
}

const ragConfig = (search: KnowledgeConfig["search"], over: Partial<KnowledgeConfig> = {}): KnowledgeConfig => ({ mode: "rag", only: false, search, ...over });
const searchWith = (hits: KnowledgeSearchHit[], log: Array<{ question: string; embedding: readonly number[] | null }> = []): NonNullable<KnowledgeConfig["search"]> =>
  async ({ question, embedding }) => {
    log.push({ question, embedding });
    return hits;
  };

describe("sessão com base de conhecimento: o prefixo do prompt", () => {
  it("os trechos entram logo antes da última fala, o prefixo fica idêntico e nada se acumula entre turnos", async () => {
    const byQuestion = new Map<string, number>();
    const t = await setup({
      knowledge: ragConfig(async ({ question }) => {
        if (!byQuestion.has(question)) byQuestion.set(question, byQuestion.size + 1);
        return [hit(byQuestion.get(question) ?? 0)];
      }),
    });
    await t.callerSays("Quanto custa a limpeza dental?");
    await t.callerSays("E o clareamento a laser?");
    const [first, second] = t.calls;
    if (!first || !second) throw new Error("faltam chamadas");
    // prefixo (a mensagem de sistema) idêntico byte a byte entre turnos
    expect(second[0]).toEqual(first[0]);
    expect(first[0]).toMatchObject({ role: "system" });
    // turno 1: [sistema, trechos, fala]
    expect(first.map((m) => m.role)).toEqual(["system", "system", "user"]);
    expect(first[1]?.content).toContain("Conteúdo secreto 1.");
    expect(first[2]).toEqual({ role: "user", content: "Quanto custa a limpeza dental?" });
    // turno 2: [sistema, fala 1, resposta 1, trechos NOVOS, fala 2], sem o trecho do turno 1
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
    expect(second[3]?.content).toContain("Conteúdo secreto 2.");
    expect(JSON.stringify(second)).not.toContain("Conteúdo secreto 1.");
    expect(second[4]).toEqual({ role: "user", content: "E o clareamento a laser?" });
  });

  it("o cache_control fica só no prefixo estável (a mensagem de sistema inicial), e a de trechos vai como texto puro", async () => {
    const t = await setup({ knowledge: ragConfig(searchWith([hit(1)])) });
    await t.callerSays("Quanto custa a limpeza dental?");
    const body = chatBody({ messages: t.calls[0] ?? [], tools: [], profile: { id: "b", model: "anthropic/claude-haiku-5.5", maxTokens: 400, cacheSystemPrompt: true, reasoning: "off", groupSlotsByDay: true } });
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.content).toEqual([expect.objectContaining({ type: "text", cache_control: { type: "ephemeral" } })]);
    expect(typeof messages[1]?.content).toBe("string");
    expect(JSON.stringify(messages.slice(1))).not.toContain("cache_control");
  });

  it("withKnowledgeContext não altera nada sem trechos e escolhe a última fala da pessoa", () => {
    const history: ChatMessage[] = [{ role: "system", content: "S" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }];
    expect(withKnowledgeContext(history, undefined)).toBe(history);
    expect(withKnowledgeContext(history, "T").map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
    expect(withKnowledgeContext([{ role: "system", content: "S" }], "T")).toHaveLength(1);
  });

  it("depois de uma ferramenta, a continuação do turno mantém os trechos do mesmo turno (sem nova busca)", async () => {
    const searches: Array<{ question: string; embedding: readonly number[] | null }> = [];
    const t = await setup({ knowledge: ragConfig(searchWith([hit(1)], searches)), toolOnFirstCall: true, config: { tools: [{ name: "lookup", description: "x", parameters: { type: "object", properties: {} } }] } });
    await t.callerSays("Quanto custa a limpeza dental?");
    const searchesAfterTurn = searches.length;
    t.session.sendToolResult("t1", { ok: true });
    await until(() => t.calls.length === 2);
    expect(searches.length).toBe(searchesAfterTurn);
    const roles = t.calls[1]?.map((m) => m.role);
    // [sistema, trechos, fala, assistente (chamada), ferramenta]: os trechos continuam antes da fala do turno
    expect(roles).toEqual(["system", "system", "user", "assistant", "tool"]);
    expect(t.calls[1]?.[1]?.content).toContain("Conteúdo secreto 1.");
  });
});

describe("sessão com base de conhecimento: orçamento e falhas", () => {
  it("orçamento estourado: o turno segue só com o que a busca por palavras já tinha", async () => {
    const lateEmbedding = new Promise<EmbeddingResult>(() => undefined);
    const search = async ({ embedding }: { embedding: readonly number[] | null }): Promise<KnowledgeSearchHit[]> => (embedding ? [hit(1)] : [hit(9)]);
    const t = await setup({ knowledge: ragConfig(search), embed: () => lateEmbedding });
    t.ports.stt.final("Quanto custa a limpeza dental?", true);
    t.timers.fire(ENDPOINT_CLOSED_MS);
    await until(() => t.timers.pending(RETRIEVAL_BUDGET_MS) > 0);
    t.timers.fire(RETRIEVAL_BUDGET_MS);
    await until(() => t.llmCalls.length === 1);
    expect(t.calls[0]?.[1]?.content).toContain("Conteúdo secreto 9.");
    expect(t.llmCalls[0]?.knowledge).toMatchObject({ mode: "rag", usedVector: false, fallback: "embedding_late" });
  });

  it("a busca que falha não derruba o turno: responde sem a base e registra o motivo, sem texto", async () => {
    const t = await setup({ knowledge: ragConfig(async () => Promise.reject(new Error("senha do banco: abc"))) });
    await t.callerSays("Quanto custa a limpeza dental?");
    expect(t.calls[0]?.map((m) => m.role)).toEqual(["system", "user"]);
    const knowledge = t.llmCalls[0]?.knowledge;
    expect(knowledge).toMatchObject({ fallback: "search_failed", hits: [] });
    expect(JSON.stringify(t.llmCalls)).not.toMatch(/senha|limpeza dental/);
  });

  it("sem a função de embedding, a busca é só por palavras e o turno segue", async () => {
    const t = await setup({ knowledge: ragConfig(searchWith([hit(3)])), withEmbed: false });
    await t.callerSays("Quanto custa a limpeza dental?");
    expect(t.calls[0]?.[1]?.content).toContain("Conteúdo secreto 3.");
    expect(t.llmCalls[0]?.knowledge).toMatchObject({ usedVector: false, fallback: "embedding_failed" });
  });

  it("fala curta não busca nem muda o prompt", async () => {
    const searches: Array<{ question: string; embedding: readonly number[] | null }> = [];
    const t = await setup({ knowledge: ragConfig(searchWith([hit(1)], searches)) });
    await t.callerSays("Tá bom, obrigado!");
    expect(searches).toEqual([]);
    expect(t.calls[0]?.map((m) => m.role)).toEqual(["system", "user"]);
    expect(t.llmCalls[0]?.knowledge).toMatchObject({ skipped: true, hits: [] });
  });
});

describe("sessão com base de conhecimento: busca especulativa", () => {
  it("o texto parcial estável dispara a busca, e no fim do turno ela é reaproveitada sem espera", async () => {
    const searches: Array<{ question: string; embedding: readonly number[] | null }> = [];
    const t = await setup({ knowledge: ragConfig(searchWith([hit(1)], searches)) });
    t.ports.stt.partial("quanto custa a limpeza");
    expect(searches).toEqual([]);
    t.timers.fire(SPECULATE_DEBOUNCE_MS);
    await until(() => searches.length === 2);
    t.ports.stt.final("Quanto custa a limpeza dental?", true);
    // o final também dispara (o texto mudou, mas parece muito com o parcial): o turno usa o que está pronto
    t.timers.fire(ENDPOINT_CLOSED_MS);
    await until(() => t.llmCalls.length === 1);
    expect(t.llmCalls[0]?.knowledge).toMatchObject({ speculative: true, usedVector: true, retrievalMs: 0 });
    expect(t.calls[0]?.[1]?.content).toContain("Conteúdo secreto 1.");
  });

  it("parcial curto (menos de 3 palavras) ou ainda mudando não dispara a busca", async () => {
    const searches: Array<{ question: string; embedding: readonly number[] | null }> = [];
    const t = await setup({ knowledge: ragConfig(searchWith([hit(1)], searches)) });
    t.ports.stt.partial("quanto custa");
    t.timers.fire(SPECULATE_DEBOUNCE_MS);
    t.ports.stt.partial("quanto custa a limpeza");
    t.ports.stt.partial("quanto custa a limpeza dental");
    // cada parcial novo cancela o anterior: só o último prazo continua pendente
    expect(t.timers.pending(SPECULATE_DEBOUNCE_MS)).toBe(1);
    await Promise.resolve();
    expect(searches).toEqual([]);
  });

  it("a fala final sobre outro assunto descarta o resultado especulativo", async () => {
    const searches: Array<{ question: string; embedding: readonly number[] | null }> = [];
    const t = await setup({ knowledge: ragConfig(searchWith([hit(1)], searches)) });
    t.ports.stt.partial("quanto custa a limpeza dental");
    t.timers.fire(SPECULATE_DEBOUNCE_MS);
    await until(() => searches.length === 2);
    await t.callerSays("Vocês atendem aos sábados de manhã?");
    // a busca usada é a do texto final (o parcial de outro assunto fica de lado): a pergunta final foi buscada, com o vetor dela
    const final = searches.filter((s) => s.question === "Vocês atendem aos sábados de manhã?");
    expect(final.length).toBeGreaterThan(0);
    expect(final.some((s) => s.embedding !== null)).toBe(true);
    expect(t.llmCalls[0]?.knowledge).toMatchObject({ usedVector: true });
  });

  it("o eco do próprio agente no parcial não dispara a busca", async () => {
    const searches: Array<{ question: string; embedding: readonly number[] | null }> = [];
    const t = await setup({ knowledge: ragConfig(searchWith([hit(1)], searches)), config: { greeting: "Bem-vindo à Clínica Sorriso, como posso ajudar hoje?" } });
    t.ports.stt.partial("bem vindo à clínica sorriso");
    t.timers.fire(SPECULATE_DEBOUNCE_MS);
    await Promise.resolve();
    expect(searches).toEqual([]);
  });
});

describe("sessão com base de conhecimento: só pela base, custo e modos", () => {
  it("só pela base e sem trechos: o modelo recebe o aviso de que nada foi achado", async () => {
    const t = await setup({ knowledge: ragConfig(searchWith([]), { only: true }) });
    await t.callerSays("Vocês fazem harmonização facial?");
    expect(t.calls[0]?.[1]?.content).toMatch(/nenhum trecho relevante/);
  });

  it("sem 'só pela base' e sem trechos: o prompt do turno fica como seria sem base", async () => {
    const t = await setup({ knowledge: ragConfig(searchWith([])) });
    await t.callerSays("Vocês fazem harmonização facial?");
    expect(t.calls[0]?.map((m) => m.role)).toEqual(["system", "user"]);
    expect(t.llmCalls[0]?.knowledge).toMatchObject({ hits: [], usedVector: true });
  });

  it("o embedding da pergunta soma no extrato da ligação (custo do provedor, em centavos)", async () => {
    const t = await setup({ knowledge: ragConfig(searchWith([hit(1)])) });
    await t.callerSays("Quanto custa a limpeza dental?");
    // 160 microcentavos = 0,00016 centavo por embedding (a especulação e o texto final pedem uns dois): soma ao custo do modelo, em leituras de uso comuns
    const embeddingCost = t.usages.reduce((sum, u) => sum + (u.providerCostCents ?? 0), 0) - 0.01;
    expect(embeddingCost).toBeGreaterThanOrEqual(160 / 1_000_000 - 1e-12);
    expect(t.llmCalls[0]?.knowledge?.embeddingTokens).toBe(8);
  });

  it("o registro dos trechos traz fonte, posição, seção e pontuação, e nunca o texto", async () => {
    const t = await setup({ knowledge: ragConfig(searchWith([hit(1), hit(2)])) });
    await t.callerSays("Quanto custa a limpeza dental?");
    expect(t.llmCalls[0]?.knowledge?.hits).toEqual([
      { chunkId: "c1", sourceId: "s1", sourceName: "Manual", position: 1, section: "Seção 1", score: 0.03, vectorScore: 0.5 },
      { chunkId: "c2", sourceId: "s1", sourceName: "Manual", position: 2, section: "Seção 2", score: 0.03, vectorScore: 0.5 },
    ]);
    expect(JSON.stringify(t.llmCalls)).not.toContain("Conteúdo secreto");
  });

  it("modo base inteira: não há busca por fala e o registro diz o modo", async () => {
    const t = await setup({ knowledge: { mode: "full", only: false } });
    await t.callerSays("Quanto custa a limpeza dental?");
    expect(t.calls[0]?.map((m) => m.role)).toEqual(["system", "user"]);
    expect(t.llmCalls[0]?.knowledge).toEqual({ mode: "full", hits: [], retrievalMs: 0, speculative: false, usedVector: false, embeddingTokens: 0 });
  });

  it("sem base: o comportamento é o de sempre (mesmas mensagens, nenhum campo novo, nenhum prazo novo)", async () => {
    const t = await setup();
    t.ports.stt.partial("quanto custa a limpeza dental");
    expect(t.timers.pending(SPECULATE_DEBOUNCE_MS)).toBe(0);
    await t.callerSays("Quanto custa a limpeza dental?");
    expect(t.calls[0]?.map((m) => m.role)).toEqual(["system", "user"]);
    expect(t.llmCalls[0]).not.toHaveProperty("knowledge");
    expect(t.usages.every((u) => u.providerCostCents === undefined || u.providerCostCents === 0.01)).toBe(true);
  });
});
