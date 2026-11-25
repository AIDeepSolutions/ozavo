import { describe, expect, it } from "vitest";
import type { KnowledgeSearchHit } from "../types";
import { KnowledgeRetriever, MAX_SPECULATIONS_PER_TURN, RETRIEVAL_BUDGET_MS, needsKnowledge, wordSimilarity, type EmbeddingResult } from "./knowledge-retrieval";

const hit = (n: number): KnowledgeSearchHit => ({ chunkId: `c${n}`, sourceId: "s1", sourceName: "Manual", position: n, section: `Seção ${n}`, content: `Texto secreto do trecho ${n}`, tokenCount: 30, vectorScore: 0.4, lexicalRank: 1, score: 0.0321 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function harness(options: { embed?: (text: string) => Promise<EmbeddingResult>; search?: (q: { question: string; embedding: readonly number[] | null }) => Promise<KnowledgeSearchHit[]> } = {}) {
  let clock = 1_000;
  const jobs: Array<{ fn: () => void; delayMs: number; cancelled: boolean }> = [];
  const searches: Array<{ question: string; embedding: readonly number[] | null }> = [];
  const embeds: string[] = [];
  const costs: Array<{ tokens: number; costMicrocents: number }> = [];
  const retriever = new KnowledgeRetriever({
    search: async (q) => {
      searches.push({ question: q.question, embedding: q.embedding });
      return options.search ? options.search(q) : q.embedding ? [hit(1), hit(2)] : [hit(2)];
    },
    embed: async (text) => {
      embeds.push(text);
      return options.embed ? options.embed(text) : { vector: [0.1, 0.2], tokens: 7, costMicrocents: 21 };
    },
    now: () => clock,
    schedule: (fn, delayMs) => {
      const job = { fn, delayMs, cancelled: false };
      jobs.push(job);
      return () => {
        job.cancelled = true;
      };
    },
    onEmbedded: (usage) => costs.push(usage),
  });
  return {
    retriever,
    searches,
    embeds,
    costs,
    advance: (ms: number) => void (clock += ms),
    budgetExpires: () => jobs.filter((job) => job.delayMs === RETRIEVAL_BUDGET_MS && !job.cancelled).forEach((job) => job.fn()),
  };
}

describe("quais falas pedem busca", () => {
  it.each(["ok", "sim", "não", "tchau", "bom dia", "tudo bem", "obrigado", "pode ser", "isso mesmo", "11 99999 8888", "dois", "um dois três", "uhum", "", "   "])("%j não pede", (text) => {
    expect(needsKnowledge(text)).toBe(false);
  });

  it.each(["quanto é a limpeza", "horário", "vocês aceitam convênio", "qual o preço do canal", "tem estacionamento?"])("%j pede", (text) => {
    expect(needsKnowledge(text)).toBe(true);
  });
});

describe("semelhança de palavras", () => {
  it("compara palavras distintas sem acento nem caixa", () => {
    expect(wordSimilarity("Quanto é a limpeza", "quanto e a limpeza")).toBe(1);
    expect(wordSimilarity("quanto custa o clareamento a laser", "quanto custa o clareamento")).toBeCloseTo(4 / 6);
    expect(wordSimilarity("", "a")).toBe(0);
  });
});

describe("busca por turno", () => {
  it("reaproveita a busca especulativa quando a fala final é a mesma: sem espera e sem nova busca", async () => {
    const h = harness();
    h.retriever.speculate("quanto custa a limpeza");
    await flush();
    const result = await h.retriever.forTurn("quanto custa a limpeza?");
    expect(result.hits.map((x) => x.chunkId)).toEqual(["c1", "c2"]);
    expect(result.info).toMatchObject({ mode: "rag", speculative: true, usedVector: true, retrievalMs: 0, embeddingTokens: 7 });
    expect(result.info.fallback).toBeUndefined();
    // uma busca por palavras e uma com vetor, ambas da especulação; nada foi refeito
    expect(h.searches).toHaveLength(2);
    expect(h.embeds).toEqual(["quanto custa a limpeza"]);
  });

  it("sem especulação, o vetor que não chega no prazo deixa só a busca por palavras, e o motivo fica registrado", async () => {
    const late = deferred<EmbeddingResult>();
    const h = harness({ embed: () => late.promise });
    const turn = h.retriever.forTurn("quanto custa a limpeza");
    await flush();
    h.advance(RETRIEVAL_BUDGET_MS);
    h.budgetExpires();
    const result = await turn;
    expect(result.hits.map((x) => x.chunkId)).toEqual(["c2"]);
    expect(result.info).toMatchObject({ usedVector: false, speculative: false, fallback: "embedding_late", retrievalMs: RETRIEVAL_BUDGET_MS });
    late.resolve({ vector: [1], tokens: 5, costMicrocents: 10 });
    await flush();
  });

  it("o embedding que falha deixa a busca por palavras, sem derrubar nada", async () => {
    const h = harness({ embed: () => Promise.reject(new Error("HTTP 500 com texto do pedido")) });
    const result = await h.retriever.forTurn("quanto custa a limpeza");
    expect(result.hits.map((x) => x.chunkId)).toEqual(["c2"]);
    expect(result.info).toMatchObject({ usedVector: false, fallback: "embedding_failed" });
    expect(JSON.stringify(result.info)).not.toContain("HTTP 500");
  });

  it("a busca que falha no banco devolve sem trechos e diz por quê", async () => {
    const h = harness({ search: () => Promise.reject(new Error("conexão caiu")) });
    const result = await h.retriever.forTurn("quanto custa a limpeza");
    expect(result.hits).toEqual([]);
    expect(result.info).toMatchObject({ usedVector: false, fallback: "search_failed" });
  });

  it("a busca que não responde no prazo devolve sem trechos (search_late)", async () => {
    const never = deferred<KnowledgeSearchHit[]>();
    const h = harness({ search: () => never.promise });
    const turn = h.retriever.forTurn("quanto custa a limpeza");
    await flush();
    h.budgetExpires();
    const result = await turn;
    expect(result.hits).toEqual([]);
    expect(result.info.fallback).toBe("search_late");
  });

  it("fala final diferente do parcial: refaz as palavras na hora e usa o vetor do parcial como aproximação", async () => {
    const h = harness();
    h.retriever.speculate("quanto custa o clareamento dental");
    await flush();
    const result = await h.retriever.forTurn("quanto custa o clareamento dental a laser aqui na clínica");
    expect(result.info).toMatchObject({ speculative: true, usedVector: true });
    // o embedding foi pedido uma vez só (o do parcial); a busca com vetor foi feita para o texto final
    expect(h.embeds).toEqual(["quanto custa o clareamento dental"]);
    expect(h.searches.at(-1)).toMatchObject({ question: "quanto custa o clareamento dental a laser aqui na clínica", embedding: [0.1, 0.2] });
  });

  it("fala final sem relação com o parcial pede o próprio embedding e descarta o especulativo", async () => {
    const h = harness();
    h.retriever.speculate("quanto custa a limpeza dental");
    await flush();
    const result = await h.retriever.forTurn("vocês atendem aos sábados de manhã");
    expect(result.info.speculative).toBe(false);
    expect(h.embeds).toEqual(["quanto custa a limpeza dental", "vocês atendem aos sábados de manhã"]);
  });

  it("fala curta não busca nada e não gasta embedding", async () => {
    const h = harness();
    h.retriever.speculate("tá bom então tchau");
    const result = await h.retriever.forTurn("ok tchau");
    expect(result.hits).toEqual([]);
    expect(result.info).toMatchObject({ skipped: true, retrievalMs: 0, embeddingTokens: 0 });
    expect(h.searches).toHaveLength(0);
    expect(h.embeds).toHaveLength(0);
  });

  it("a mesma pergunta duas vezes na ligação pede o embedding uma vez só", async () => {
    const h = harness();
    await h.retriever.forTurn("quanto custa a limpeza");
    await h.retriever.forTurn("quanto custa a limpeza");
    expect(h.embeds).toHaveLength(1);
    expect(h.costs).toEqual([{ tokens: 7, costMicrocents: 21 }]);
  });

  it("embedding que falhou não fica no cache: a próxima vez tenta de novo", async () => {
    let calls = 0;
    const h = harness({ embed: async () => (++calls === 1 ? Promise.reject(new Error("x")) : { vector: [1], tokens: 3, costMicrocents: 9 }) });
    await h.retriever.forTurn("quanto custa a limpeza");
    await flush();
    const second = await h.retriever.forTurn("quanto custa a limpeza");
    expect(second.info.usedVector).toBe(true);
    expect(calls).toBe(2);
  });

  it("limita as buscas especulativas por turno e ignora texto que quase não mudou", async () => {
    const h = harness();
    for (let i = 0; i < MAX_SPECULATIONS_PER_TURN + 3; i += 1) h.retriever.speculate(`pergunta${i} sobre algo${i} diferente${i}`);
    h.retriever.speculate("pergunta0 sobre algo0 diferente0");
    await flush();
    expect(h.embeds).toHaveLength(MAX_SPECULATIONS_PER_TURN);
    // o texto definitivo (a fala final) sai mesmo com o limite esgotado
    h.retriever.speculate("a fala final já é outra coisa completamente", true);
    await flush();
    expect(h.embeds).toHaveLength(MAX_SPECULATIONS_PER_TURN + 1);
  });

  it("o registro de auditoria leva ids, posição, seção e pontuação, nunca o texto do trecho nem o da pergunta", async () => {
    const h = harness();
    const result = await h.retriever.forTurn("quanto custa a limpeza");
    const logged = JSON.stringify(result.info);
    expect(logged).toContain("c1");
    expect(logged).toContain("Seção 1");
    expect(logged).not.toContain("Texto secreto");
    expect(logged).not.toContain("limpeza");
  });
});

describe("busca especulativa enquanto a pessoa fala", () => {
  it("acompanha o texto parcial palavra a palavra, para o vetor mais recente ser o que chega a tempo, até o limite do turno", async () => {
    const h = harness();
    const words = "quanto custa o clareamento dental a laser aqui na clínica sorriso verde hoje".split(" ");
    for (let n = 3; n <= words.length; n += 1) h.retriever.speculate(words.slice(0, n).join(" "));
    await flush();
    expect(h.embeds.length).toBe(MAX_SPECULATIONS_PER_TURN);
    expect(h.embeds[0]).toBe("quanto custa o");
  });

  it("repetição quase idêntica do mesmo parcial não pede de novo", async () => {
    const h = harness();
    h.retriever.speculate("quanto custa o clareamento dental a laser aqui na clínica");
    h.retriever.speculate("quanto custa o clareamento dental a laser aqui na clínica.");
    await flush();
    expect(h.embeds).toHaveLength(1);
  });
});
