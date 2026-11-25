import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EmbeddingError, embedTexts, listPriceMicrocents, toVectorLiteral } from "./embeddings";
import { fakeEmbedding, fakeEmbeddingsFetch } from "../test/fake-embeddings";

const noSleep = async (): Promise<void> => undefined;

describe("embedTexts", () => {
  it("devolve um vetor por texto, na ordem, com os tokens e o custo da resposta", async () => {
    const calls: Array<{ inputs: string[]; authorization: string | null }> = [];
    const result = await embedTexts(["horário de atendimento", "preço da consulta"], { apiKey: "sk-teste", fetch: fakeEmbeddingsFetch(calls), sleep: noSleep });
    expect(result.vectors).toEqual([fakeEmbedding("horário de atendimento"), fakeEmbedding("preço da consulta")]);
    expect(result.model).toBe(EMBEDDING_MODEL);
    expect(result.tokens).toBe(6);
    expect(result.costMicrocents).toBe(Math.round(6 * 2e-8 * 100_000_000));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer sk-teste");
  });

  it("divide em pedidos de até 64 entradas", async () => {
    const calls: Array<{ inputs: string[]; authorization: string | null }> = [];
    const inputs = Array.from({ length: 150 }, (_, i) => `trecho número ${i}`);
    const result = await embedTexts(inputs, { apiKey: "k", fetch: fakeEmbeddingsFetch(calls), sleep: noSleep });
    expect(calls.map((call) => call.inputs.length)).toEqual([64, 64, 22]);
    expect(result.vectors).toHaveLength(150);
    expect(result.vectors[149]).toEqual(fakeEmbedding("trecho número 149"));
  });

  it("repete o que falha de forma transitória e desiste do que não adianta repetir", async () => {
    let calls = 0;
    const flaky = (async (url: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response("", { status: 429 });
      return fakeEmbeddingsFetch()(url as string, init);
    }) as typeof fetch;
    const waits: number[] = [];
    const result = await embedTexts(["a b c"], { apiKey: "k", fetch: flaky, sleep: async (ms) => void waits.push(ms) });
    expect(result.vectors).toHaveLength(1);
    expect(calls).toBe(2);
    expect(waits).toEqual([500]);

    const refused = (async () => new Response("", { status: 401 })) as typeof fetch;
    await expect(embedTexts(["x"], { apiKey: "chave-secreta", fetch: refused, sleep: noSleep })).rejects.toMatchObject({ code: "embedding_http", retryable: false, status: 401 });
  });

  it("não deixa a chave nem o texto na mensagem do erro", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED com chave-secreta");
    }) as typeof fetch;
    const error = await embedTexts(["texto-privado"], { apiKey: "chave-secreta", fetch: down, attempts: 1, sleep: noSleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect(String((error as Error).message)).not.toContain("chave-secreta");
    expect(String((error as Error).message)).not.toContain("texto-privado");
    expect(error).toMatchObject({ code: "embedding_unreachable", retryable: true });
  });

  it("recusa resposta com número de dimensões errado ou formato inesperado", async () => {
    const short = (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } }))) as typeof fetch;
    await expect(embedTexts(["x"], { apiKey: "k", fetch: short, sleep: noSleep })).rejects.toMatchObject({ code: "embedding_bad_response", retryable: false });
    const odd = (async () => new Response(JSON.stringify({ nada: true }))) as typeof fetch;
    await expect(embedTexts(["x"], { apiKey: "k", fetch: odd, sleep: noSleep })).rejects.toMatchObject({ code: "embedding_bad_response" });
  });

  it("sem custo na resposta, usa o preço de tabela", async () => {
    const noCost = (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(0) }], usage: { prompt_tokens: 1_000_000 } }))) as typeof fetch;
    const result = await embedTexts(["x"], { apiKey: "k", fetch: noCost, sleep: noSleep });
    expect(result.costMicrocents).toBe(listPriceMicrocents(1_000_000));
    expect(result.costMicrocents).toBe(2_000_000);
  });

  it("escreve o vetor como o pgvector lê", () => {
    expect(toVectorLiteral([0.5, -1, 0])).toBe("[0.5,-1,0]");
  });
});
