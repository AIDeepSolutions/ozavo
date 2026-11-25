import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS, normalizeSearchText } from "../src/index";

/**
 * Embedding de mentira, determinístico e sem rede: cada palavra (sem acento) soma 1 numa posição
 * escolhida pelo hash dela, e o vetor é normalizado. Dois textos com palavras em comum ficam
 * próximos no cosseno, o que basta para provar a ordem da busca sem chamar nenhum provedor.
 */
export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of normalizeSearchText(text).match(/[a-z0-9]{3,}/g) ?? []) {
    const slot = createHash("sha1").update(word).digest().readUInt16BE(0) % EMBEDDING_DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

/** Um `fetch` que responde como o OpenRouter `/embeddings`, com tokens contados por palavra. */
export function fakeEmbeddingsFetch(calls: Array<{ inputs: string[]; authorization: string | null }> = []): typeof fetch {
  return (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    calls.push({ inputs: body.input, authorization: new Headers(init?.headers).get("authorization") });
    const tokens = body.input.reduce((sum, text) => sum + text.split(/\s+/).length, 0);
    return new Response(
      JSON.stringify({
        data: body.input.map((text, index) => ({ index, embedding: fakeEmbedding(text) })),
        usage: { prompt_tokens: tokens, total_tokens: tokens, cost: tokens * 2e-8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}
