import { DEFAULT_TOP_K } from "../knowledge-prompt";
import type { KnowledgeCallInfo, KnowledgeConfig, KnowledgeFallback, KnowledgeSearchHit } from "../types";

/**
 * A busca na base de conhecimento a cada fala de quem ligou, com um orçamento de latência.
 *
 * O que decide o desenho (medido em 25/11/2026, docs/decisions/0022-base-de-conhecimento.md):
 *   - a busca por palavras custa ~0 ms (0,02 ms em memória; poucos ms no Postgres) e acertou 8/10;
 *   - o embedding da pergunta pelo OpenRouter leva ~455 ms (p50) e acerta 8 a 9/10: bom demais para jogar
 *     fora, lento demais para esperar.
 * Então as duas buscas saem JUNTAS, a das palavras na hora e a do vetor em paralelo, e o turno só espera o
 * vetor dentro do orçamento (`budgetMs`). E a busca é ESPECULATIVA: dispara no texto parcial da transcrição,
 * enquanto a pessoa ainda fala, de modo que no fim do turno o resultado costuma estar pronto e a espera é zero.
 *
 * Regras que não mudam:
 *   - a busca NUNCA derruba o turno: falha, atraso e erro viram "sem trechos" ou "só palavras" e um motivo
 *     no registro (`fallback`), nunca uma exceção;
 *   - o texto da pergunta e o dos trechos não vão para o registro (só ids, posição, seção e pontuação);
 *   - falas curtas (ok, sim, tchau, número) não pedem busca;
 *   - cada embedding é pedido uma vez (cache da ligação) e todo embedding pedido entra no custo.
 */

/** Quanto o turno espera pela busca depois que a pessoa terminou de falar. */
export const RETRIEVAL_BUDGET_MS = 100;
/** O texto parcial precisa ficar assim, parado, para a busca especulativa sair. */
export const SPECULATE_DEBOUNCE_MS = 120;
export const SPECULATE_MIN_WORDS = 3;
/** Semelhança de palavras a partir da qual o resultado da busca especulativa vale para o texto final. */
export const REUSE_SIMILARITY = 0.8;
/** A partir dela, o vetor do texto parcial serve de aproximação para o texto final (que difere mais). */
export const APPROXIMATE_SIMILARITY = 0.5;
/**
 * Buscas especulativas por turno a partir de texto parcial: limita o gasto e as idas ao provedor quando a pessoa fala
 * muito. Uma nova só sai quando o texto mudou (menos de `SPECULATE_MIN_CHANGE` de semelhança com a anterior): numa frase
 * curta, a cada palavra nova; numa longa, a cada palavra ou duas. O embedding leva ~0,5 s, quase o que dura a última palavra
 * mais a pausa do fim de turno, então o parcial MAIS RECENTE é o que chega a tempo: esperar mudar muito o deixaria velho.
 * A do texto final (definitivo) não conta.
 */
export const MAX_SPECULATIONS_PER_TURN = 8;
export const SPECULATE_MIN_CHANGE = 0.9;
const EMBEDDING_CACHE_SIZE = 64;

export interface EmbeddingResult {
  vector: readonly number[];
  tokens: number;
  /** Microcentavos de dólar (1 US$ = 100.000.000), o valor cobrado, como `embedTexts` devolve. */
  costMicrocents: number;
}

export interface RetrieverDeps {
  search: NonNullable<KnowledgeConfig["search"]>;
  /** Pede o embedding de uma pergunta. Pode lançar: a busca segue só por palavras. */
  embed(text: string): Promise<EmbeddingResult>;
  now(): number;
  /** Agenda o fim do orçamento (o mesmo agendador da sessão). Devolve como cancelar. */
  schedule(fn: () => void, delayMs: number): () => void;
  topK?: number;
  budgetMs?: number;
  /** Chamada a cada embedding pedido de fato (não a cada cache): é o que entra no extrato. */
  onEmbedded?(usage: { tokens: number; costMicrocents: number }): void;
}

const ACKNOWLEDGEMENTS = new Set([
  // pt
  "ok", "okay", "oks", "sim", "nao", "não", "certo", "certinho", "ta", "tá", "tah", "ta bom", "beleza", "blz", "bom", "boa", "dia", "tarde", "noite", "oi", "ola", "olá", "alo", "alô", "obrigado", "obrigada", "valeu", "tchau", "ate", "até", "logo", "amanha", "amanhã", "pode", "ser", "entendi", "entendido", "claro", "isso", "aham", "uhum", "hum", "ahn", "ah", "eh", "é", "tudo", "bem", "tranquilo", "perfeito", "otimo", "ótimo", "show", "joia", "jóia", "por", "favor", "falou", "fechado", "combinado", "sei", "então", "entao", "e", "ai", "aí", "la", "lá", "mesmo", "isso mesmo", "com", "licenca", "licença", "desculpa", "desculpe", "como", "disse", "repete", "repita", "perdao", "perdão", "quem", "fala", "aqui", "sou", "eu", "um", "momento", "minuto", "segundo", "aguarda", "aguardo",
  // en
  "yes", "yeah", "yep", "no", "nope", "right", "sure", "fine", "good", "great", "hello", "hi", "hey", "thanks", "thank", "you", "bye", "goodbye", "see", "later", "got", "it", "alright", "okay", "please", "sorry", "pardon", "what", "uh", "huh", "i", "am", "this", "is", "speaking", "wait", "moment", "minute",
  // es
  "si", "sí", "vale", "bueno", "buenos", "dias", "días", "tardes", "noches", "hola", "gracias", "adios", "adiós", "hasta", "luego", "entiendo", "claro", "perfecto", "genial", "perdon", "perdón", "disculpe", "espere", "momento",
]);

const NUMBER_WORDS = new Set(["zero", "um", "uma", "dois", "duas", "tres", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "cero", "uno", "dos", "cuatro", "seis", "siete", "ocho", "nueve", "diez"]);

const normalizeWords = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");

const ACK_NORMALIZED = new Set([...ACKNOWLEDGEMENTS, ...NUMBER_WORDS].flatMap((entry) => normalizeWords(entry)));

export const wordCount = (text: string): number => normalizeWords(text).length;

/**
 * A fala pede busca? Não pede quando só tem confirmação, saudação, despedida, hesitação ou número (telefone,
 * CPF, data, "dois"): ali o modelo responde com o que já tem, e a busca só traria trecho irrelevante.
 * Com qualquer palavra de conteúdo ("horário", "preço", "convênio"), pede.
 */
export function needsKnowledge(text: string): boolean {
  const words = normalizeWords(text);
  if (words.length === 0) return false;
  return words.some((word) => !ACK_NORMALIZED.has(word) && !/^\d+$/.test(word));
}

/** Semelhança de palavras, de 0 a 1: quantas palavras distintas as duas falas têm em comum, sobre a maior das duas. */
export function wordSimilarity(a: string, b: string): number {
  const first = new Set(normalizeWords(a));
  const second = new Set(normalizeWords(b));
  if (first.size === 0 || second.size === 0) return 0;
  let common = 0;
  for (const word of first) if (second.has(word)) common += 1;
  return common / Math.max(first.size, second.size);
}

type Settled<T> = { ok: true; value: T } | { ok: false };

/** Uma promessa que não rejeita e que sabe dizer se já terminou (sem esperar). */
interface Tracked<T> {
  promise: Promise<Settled<T>>;
  state: Settled<T> | undefined;
}

function track<T>(make: () => Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { promise: undefined as unknown as Promise<Settled<T>>, state: undefined };
  tracked.promise = (async () => {
    try {
      tracked.state = { ok: true, value: await make() };
    } catch {
      // O motivo não vai para o registro: pode vir do provedor e carregar texto do pedido.
      tracked.state = { ok: false };
    }
    return tracked.state;
  })();
  return tracked;
}

interface Entry {
  text: string;
  lexical: Tracked<KnowledgeSearchHit[]>;
  embedding: Tracked<EmbeddingResult>;
  /** A busca com o vetor (espera o embedding). */
  vector: Tracked<KnowledgeSearchHit[]>;
}

export interface TurnRetrieval {
  hits: KnowledgeSearchHit[];
  info: KnowledgeCallInfo;
}

const auditHit = (hit: KnowledgeSearchHit): KnowledgeCallInfo["hits"][number] => ({
  chunkId: hit.chunkId,
  sourceId: hit.sourceId,
  sourceName: hit.sourceName,
  position: hit.position,
  section: hit.section,
  score: Math.round(hit.score * 10000) / 10000,
  vectorScore: hit.vectorScore === null ? null : Math.round(hit.vectorScore * 1000) / 1000,
});

export class KnowledgeRetriever {
  private readonly k: number;
  private readonly budgetMs: number;
  private readonly cache = new Map<string, Tracked<EmbeddingResult>>();
  private entries: Entry[] = [];
  private speculations = 0;
  private turnEmbeddingTokens = 0;

  constructor(private readonly deps: RetrieverDeps) {
    this.k = deps.topK ?? DEFAULT_TOP_K;
    this.budgetMs = deps.budgetMs ?? RETRIEVAL_BUDGET_MS;
  }

  /**
   * Dispara a busca para um texto ainda parcial (ou `definitive`: o trecho final da transcrição, que não muda mais). Não espera nada e não falha: o resultado fica guardado para
   * `forTurn`. Falas que não pedem busca, repetições e o excesso do turno são ignorados.
   */
  speculate(text: string, definitive = false): void {
    if (!needsKnowledge(text)) return;
    if (!definitive && this.speculations >= MAX_SPECULATIONS_PER_TURN) return;
    const last = this.entries.at(-1);
    if (last && wordSimilarity(last.text, text) >= (definitive ? 0.95 : SPECULATE_MIN_CHANGE)) return;
    if (!definitive) this.speculations += 1;
    this.entries.push(this.start(text));
  }

  /**
   * A busca para a fala final do turno, dentro do orçamento. Nunca lança e nunca espera mais que `budgetMs`:
   * reaproveita a busca especulativa quando a fala final é igual ou quase (`REUSE_SIMILARITY`); senão busca as
   * palavras da fala final na hora, com o vetor do texto parcial como aproximação (quando ele se parece
   * o bastante) ou o da própria fala.
   */
  async forTurn(text: string): Promise<TurnRetrieval> {
    const startedAt = this.deps.now();
    const base = { mode: "rag" as const, speculative: false, usedVector: false };
    if (!needsKnowledge(text)) {
      this.reset();
      return { hits: [], info: { ...base, hits: [], retrievalMs: 0, embeddingTokens: this.drainTokens(), skipped: true } };
    }
    const closest = [...this.entries].sort((a, b) => wordSimilarity(b.text, text) - wordSimilarity(a.text, text))[0];
    const similarity = closest ? wordSimilarity(closest.text, text) : 0;
    // Parecida o bastante: vale a busca inteira. Menos, mas ainda a mesma pergunta: a busca de palavras é refeita
    // para o texto final, e o vetor do parcial serve de aproximação (poupa uma ida ao provedor).
    const entry = closest && similarity >= REUSE_SIMILARITY ? closest : this.start(text, closest && similarity >= APPROXIMATE_SIMILARITY ? closest.embedding : undefined);
    const speculative = closest !== undefined && similarity >= APPROXIMATE_SIMILARITY;
    const outcome = await this.within(entry.vector.promise, this.budgetMs);
    let hits: KnowledgeSearchHit[] = [];
    let usedVector = false;
    let fallback: KnowledgeFallback | undefined;
    if (outcome !== "timeout" && outcome.ok) {
      hits = outcome.value;
      usedVector = true;
    } else {
      // O vetor falhou (ou o prazo acabou): vale o que a busca de palavras já tem. Se ela ainda roda, espera o que resta do prazo.
      if (outcome !== "timeout" && entry.lexical.state === undefined) {
        const left = this.budgetMs - (this.deps.now() - startedAt);
        if (left > 0) await this.within(entry.lexical.promise, left);
      }
      const lexical = entry.lexical.state;
      const embeddingFailed = entry.embedding.state?.ok === false;
      if (lexical?.ok) hits = lexical.value;
      if (outcome === "timeout") {
        fallback = lexical === undefined ? "search_late" : lexical.ok ? (embeddingFailed ? "embedding_failed" : "embedding_late") : "search_failed";
      } else {
        fallback = embeddingFailed ? "embedding_failed" : "search_failed";
      }
    }
    const result: TurnRetrieval = {
      hits,
      info: {
        ...base,
        hits: hits.map(auditHit),
        retrievalMs: Math.max(0, this.deps.now() - startedAt),
        speculative,
        usedVector,
        embeddingTokens: this.drainTokens(),
        ...(fallback && { fallback }),
      },
    };
    this.reset();
    return result;
  }

  private reset(): void {
    this.entries = [];
    this.speculations = 0;
  }

  private drainTokens(): number {
    const tokens = this.turnEmbeddingTokens;
    this.turnEmbeddingTokens = 0;
    return tokens;
  }

  private embedCached(text: string): Tracked<EmbeddingResult> {
    const key = normalizeWords(text).join(" ");
    const cached = this.cache.get(key);
    if (cached) return cached;
    const tracked = track(async () => {
      const result = await this.deps.embed(text);
      this.turnEmbeddingTokens += result.tokens;
      this.deps.onEmbedded?.({ tokens: result.tokens, costMicrocents: result.costMicrocents });
      return result;
    });
    this.cache.set(key, tracked);
    if (this.cache.size > EMBEDDING_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    // Falha não fica guardada: a próxima vez que a pergunta aparecer, tenta de novo.
    void tracked.promise.then((settled) => {
      if (!settled.ok && this.cache.get(key) === tracked) this.cache.delete(key);
    });
    return tracked;
  }

  /** Dispara as duas buscas em paralelo: palavras agora, vetor quando o embedding chegar. */
  private start(text: string, embeddingOf?: Tracked<EmbeddingResult>): Entry {
    const lexical = track(() => this.deps.search({ question: text, embedding: null, k: this.k }));
    const embedding = embeddingOf ?? this.embedCached(text);
    const vector = track(async () => {
      const settled = await embedding.promise;
      if (!settled.ok) throw new Error("embedding");
      return this.deps.search({ question: text, embedding: settled.value.vector, k: this.k });
    });
    return { text, lexical, embedding, vector };
  }

  /** A promessa, ou `"timeout"` quando o prazo (no agendador da sessão) vem primeiro. */
  private within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
    return new Promise((resolve) => {
      const cancel = this.deps.schedule(() => resolve("timeout"), ms);
      void promise.then((value) => {
        cancel();
        resolve(value);
      });
    });
  }
}
