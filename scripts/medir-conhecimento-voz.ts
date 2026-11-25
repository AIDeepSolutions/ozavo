/**
 * Bancada opt-in da base de conhecimento na voz (marco 3): sobe a sessão REAL do motor em pipeline
 * (`connectPipeline`) com a transcrição (Deepgram) e a síntese (Cartesia) simuladas por servidores WebSocket
 * locais, e usa o OpenRouter de verdade para o modelo de texto e para os embeddings. A base é a sintética
 * (manual da clínica Sorriso Verde), indexada num Postgres local com embeddings reais.
 *
 * Mede por turno, no relógio real: espera pela busca (a que o turno viu), tempo do banco e do embedding,
 * primeiro token do modelo, primeira frase, tokens (entrada, cache, saída), custo e, no fim, se o fato esperado
 * aparece na resposta (um juiz de texto confere; a busca por texto é só a referência) nos modos `rag` e `full`.
 *
 * Uso (Postgres vazio, dono do schema; a chave do OpenRouter só do ambiente, nunca impressa nem gravada):
 *   BENCH_DATABASE_URL=postgres://postgres@127.0.0.1:55440/NOME OPENROUTER_API_KEY=... \
 *     pnpm tsx scripts/medir-conhecimento-voz.ts --live --out PASTA [--limit 40] [--configs rag-b,full-e] [--budget 0.9] [--jev]
 *
 * Só grava métricas e as respostas da base sintética: nenhuma credencial, nenhum áudio.
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  chunkText,
  claimKnowledgeVersion,
  completeKnowledgeVersion,
  composeCallInstructions,
  createDb,
  createKnowledgeSource,
  embedTexts,
  setAgentKnowledge,
  systemClock,
  withOrg,
  withSystem,
  type KnowledgeMode,
  type OrgQuery,
} from "../packages/core/src/index";
import { runMigrations } from "../packages/core/src/migrate";
import { autoCommitOrgQuery } from "../packages/tools/src/org-query";
import { prepareCallKnowledge } from "../apps/voice/src/knowledge";
import { connectPipeline } from "../packages/voice-engine/src/engines/deepgram-openrouter-cartesia";
import { encodePipelineKey } from "../packages/voice-engine/src/pipeline/credentials";
import { startFakeWs } from "../packages/voice-engine/src/testing/fake-pipeline";
import type { LlmCallInfo, VoiceSession } from "../packages/voice-engine/src/types";
import type { TurnMetrics } from "../packages/voice-engine/src/pipeline/session";
import type { LlmProfileId } from "../packages/voice-engine/src/pipeline/llm-profile";
import { needsKnowledge } from "../packages/voice-engine/src/pipeline/knowledge-retrieval";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(process.env.HOME ?? "", "agent-state/entregas/ozavo-base-conhecimento-25nov/dados/sintetica");

interface Question {
  q: string;
  expected: string[];
  section: string;
  kind: string;
}

interface Config {
  id: string;
  mode: "rag" | "full";
  profile: LlmProfileId;
  label: string;
  /** Quanto o turno espera pela busca (padrão do motor: 100 ms). */
  budgetMs?: number;
  /** Variante sem vetor: o embedding é recusado de imediato e a busca é só por palavras. */
  lexicalOnly?: boolean;
}

const MODELS: Record<string, { profile: LlmProfileId; label: string }> = {
  b: { profile: "b", label: "Haiku 5.5 (perfil B)" },
  e: { profile: "e", label: "DeepSeek V4.1 Flash@Together (perfil E)" },
  d: { profile: "d", label: "gpt-oss-120b (perfil D)" },
};
const CONFIGS: Config[] = [
  ...(["rag", "full"] as const).flatMap((mode) => Object.entries(MODELS).map(([key, m]): Config => ({ id: `${mode}-${key}`, mode, profile: m.profile, label: `${mode === "rag" ? "Busca" : "Base inteira"} · ${m.label}` }))),
  // Variantes da busca para decidir o preço do vetor: só palavras (sem espera) e orçamento largo (espera o vetor chegar).
  { id: "rag-b-lex", mode: "rag", profile: "b", lexicalOnly: true, label: `Busca só por palavras · ${MODELS.b?.label}` },
  { id: "rag-e-lex", mode: "rag", profile: "e", lexicalOnly: true, label: `Busca só por palavras · ${MODELS.e?.label}` },
  { id: "rag-e-450", mode: "rag", profile: "e", budgetMs: 450, label: `Busca, espera até 450 ms · ${MODELS.e?.label}` },
];

const AGENT_INSTRUCTIONS =
  "Você é a Júlia, recepcionista da Clínica Odontológica Sorriso Verde, e atende ligações. " +
  "Responda dúvidas sobre serviços, preços, horários, convênios e políticas da clínica. " +
  "Se a pessoa quiser agendar, diga que vai anotar o pedido e que a equipe retorna.";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
};
const round = (n: number | null, digits = 0): number | null => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

const note = (message: string): void => void process.stderr.write(`${message}\n`);

let spentUsd = 0;
const spend = (usd: number): void => void (spentUsd += usd);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Credencial ou conexão ausente: ${name}`);
  return value;
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** Referência barata: o fato aparece escrito igual (números canônicos; "R$ 1.200,00" casa "1200 reais"). */
function factInText(text: string, fact: string): boolean {
  const canon = (s: string): string[] => (normalize(s).match(/\d[\d.]*(?:,\d+)?/g) ?? []).map((n) => n.replace(/\.(?=\d{3}\b)/g, "").replace(",", ".").replace(/\.00$/, ""));
  const factNumbers = canon(fact);
  if (factNumbers.length > 0) {
    const have = new Set(canon(text));
    if (factNumbers.every((n) => have.has(n))) return true;
  }
  return normalize(text).includes(normalize(fact));
}

async function judge(apiKey: string, input: { question: string; expected: string[]; answer: string }): Promise<{ ok: boolean; costUsd: number }> {
  const outOfBase = input.expected.length === 0;
  const prompt = outOfBase
    ? `Pergunta de quem ligou: "${input.question}"\nA informação NÃO está na base da clínica. Resposta do agente: "${input.answer}"\nO agente admite que não tem essa informação (ou oferece anotar/transferir) SEM afirmar preço, horário ou política inventados? Responda só JSON: {"ok": true|false}`
    : `Pergunta de quem ligou: "${input.question}"\nFatos que a resposta correta precisa conter: ${JSON.stringify(input.expected)}\nResposta do agente: "${input.answer}"\nA resposta contém TODOS esses fatos (aceite números por extenso, formatos equivalentes e paráfrase) e não contradiz nenhum? Responda só JSON: {"ok": true|false}`;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-haiku-5.5", messages: [{ role: "user", content: prompt }], max_tokens: 30, temperature: 0, reasoning: { enabled: false } }),
    signal: AbortSignal.timeout(30000),
  });
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number } };
  const cost = body.usage?.cost ?? 0;
  spend(cost);
  return { ok: /"ok"\s*:\s*true/.test(body.choices?.[0]?.message?.content ?? ""), costUsd: cost };
}

interface Db2 {
  app: ReturnType<typeof createDb>;
  owner: ReturnType<typeof createDb>;
}

async function openDatabases(): Promise<Db2> {
  const ownerUrl = requireEnv("BENCH_DATABASE_URL");
  const owner = createDb(ownerUrl);
  await runMigrations(owner, path.join(ROOT, "db/migrations"));
  await owner.pool.query("alter role ozavo_app password 'ozavo_test'");
  await owner.pool.query("alter role ozavo_system password 'ozavo_test'");
  const roleUrl = (role: string): string => {
    const url = new URL(ownerUrl);
    url.username = role;
    url.password = "ozavo_test";
    return url.toString();
  };
  return { owner, app: createDb(roleUrl("ozavo_app"), roleUrl("ozavo_system")) };
}

interface TurnRecord {
  config: string;
  mode: "rag" | "full";
  profile: string;
  turn: number;
  kind: string;
  question: string;
  words: number;
  skippedByHeuristic: boolean;
  /** O que o turno esperou pela busca além do que já esperava (ms). */
  retrievalVisibleMs: number | null;
  speculative: boolean | null;
  usedVector: boolean | null;
  fallback: string | null;
  hits: number | null;
  /** Tempo real do banco em cada busca do turno (ms), com e sem vetor. */
  dbSearchMs: Array<{ vector: boolean; ms: number }>;
  /** Tempo real de cada embedding pedido no turno (ms). */
  embedMs: number[];
  /** Do fim da fala ao primeiro token do modelo (inclui o fim de turno e a espera pela busca). */
  userEndToFirstTokenMs: number | null;
  /** Do pedido ao modelo (já com os trechos) ao primeiro token. */
  modelFirstTokenMs: number | null;
  /** Do pedido ao modelo à primeira frase entregue à síntese. */
  firstSentenceMs: number | null;
  /** Do fim da fala ao primeiro áudio (RTT com a síntese simulada instantânea). */
  rttMs: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
  embeddingTokens: number | null;
  costUsd: number;
  provider: string | null;
  answer: string;
  expected: string[];
  factInRetrieved: boolean | null;
  factInAnswerText: boolean;
  judgeOk: boolean | null;
}

async function runConfig(input: {
  config: Config;
  questions: Question[];
  apiKey: string;
  app: Db2["app"];
  organizationId: string;
  agentId: string;
  chunkTextById: Map<string, string>;
  out: string;
}): Promise<TurnRecord[]> {
  const { config, questions, apiKey, app, organizationId, agentId } = input;
  const orgQuery = (): OrgQuery => autoCommitOrgQuery(app, organizationId);
  const records: TurnRecord[] = [];
  const knowledge = await prepareCallKnowledge({ orgQuery, agentId, language: "pt-BR", supportsRetrieval: true, now: () => systemClock.now().getTime(), log: () => undefined });
  if (knowledge.kind !== "ready") throw new Error(`base não carregou para ${config.id}`);
  const dbSearchLog: Array<{ vector: boolean; ms: number }> = [];
  const knowledgeConfig = knowledge.config.search
    ? {
        ...knowledge.config,
        ...(config.budgetMs !== undefined && { budgetMs: config.budgetMs }),
        search: async (query: Parameters<NonNullable<typeof knowledge.config.search>>[0]) => {
          const t0 = performance.now();
          try {
            return await (knowledge.config.search as NonNullable<typeof knowledge.config.search>)(query);
          } finally {
            dbSearchLog.push({ vector: query.embedding !== null, ms: performance.now() - t0 });
          }
        },
      }
    : knowledge.config;

  const deepgram = await startFakeWs();
  const cartesia = await startFakeWs();
  const embedLog: number[] = [];
  let chatStartedAt: number | undefined;
  let firstTokenAt: number | undefined;
  /** Texto entregue à síntese, com o instante do primeiro pedaço. */
  let firstSpeakAt: number | undefined;
  const timedFetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    const t0 = performance.now();
    if (target.endsWith("/embeddings")) {
      if (config.lexicalOnly) return new Response("", { status: 500 });
      const response = await fetch(url as string, init);
      embedLog.push(performance.now() - t0);
      return response;
    }
    chatStartedAt = t0;
    firstTokenAt = undefined;
    const response = await fetch(url as string, init);
    if (!response.body) return response;
    const decoder = new TextDecoder();
    const watched = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (firstTokenAt === undefined && /"content":"[^"]/.test(decoder.decode(chunk, { stream: true }))) firstTokenAt = performance.now();
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(watched, { status: response.status, headers: response.headers });
  }) as typeof fetch;

  const metrics: TurnMetrics[] = [];
  const llmCalls: LlmCallInfo[] = [];
  let usdThisTurn = 0;
  const agentSaid: string[] = [];
  const key = encodePipelineKey({ deepgram: "dg-simulada", cartesia: "ct-simulada", openrouter: apiKey });
  const session: VoiceSession = await connectPipeline(
    {
      instructions: composeCallInstructions({ basePrompt: "", agentInstructions: AGENT_INSTRUCTIONS, knowledgeSection: knowledge.section }),
      language: "pt-BR",
      tools: [],
      llmProfile: config.profile,
      knowledge: knowledgeConfig,
    },
    key,
    { urls: { stt: deepgram.url, tts: cartesia.url }, clock: systemClock, fetch: timedFetch, onMetrics: (m) => metrics.push(m), amd: false },
  );
  session.on("llmCall", (call) => llmCalls.push(call));
  session.on("usage", (usage) => void (usageThisTurn(usage.providerCostCents ?? 0)));
  session.on("transcript", (turn) => {
    if (turn.speaker === "agent") agentSaid.push(turn.text);
  });
  session.on("error", () => undefined);
  function usageThisTurn(cents: number): void {
    usdThisTurn += cents / 100;
  }

  // A síntese simulada: o primeiro pedaço de cada contexto devolve áudio na hora, e o último fecha o contexto.
  let ttsRunning = true;
  // Um `waitFor` por vez e sem prazo: um pedido pendurado engoliria a mensagem seguinte. O laço fica pendurado ao fim e morre com o processo.
  void (async () => {
    while (ttsRunning) {
      const message = await cartesia.waitFor((m) => typeof m.transcript === "string");
      const contextId = String(message.context_id);
      if (firstSpeakAt === undefined && String(message.transcript).trim() !== "") firstSpeakAt = performance.now();
      cartesia.send({ type: "chunk", data: Buffer.alloc(160, 0xff).toString("base64"), context_id: contextId });
      if (message.continue === false) cartesia.send({ type: "done", context_id: contextId });
    }
  })();

  const WORD_MS = 330;
  const ENDPOINTING_MS = 250;
  try {
    for (const [index, item] of questions.entries()) {
      if (spentUsd > Number(arg("budget") ?? "0.9")) {
        note(`[${config.id}] teto de gasto atingido; parando na pergunta ${index + 1}`);
        break;
      }
      dbSearchLog.length = 0;
      embedLog.length = 0;
      llmCalls.length = 0;
      metrics.length = 0;
      agentSaid.length = 0;
      usdThisTurn = 0;
      chatStartedAt = undefined;
      firstTokenAt = undefined;
      firstSpeakAt = undefined;
      const words = item.q.split(/\s+/);
      const finalText = `${item.q.charAt(0).toUpperCase()}${item.q.slice(1)}?`;
      // A pessoa fala palavra por palavra (a transcrição parcial cresce) e, ao terminar, a Deepgram fecha o trecho.
      for (let n = 1; n <= words.length; n += 1) {
        deepgram.send({ type: "Results", is_final: false, speech_final: false, channel: { alternatives: [{ transcript: words.slice(0, n).join(" ") }] } });
        await new Promise((resolve) => setTimeout(resolve, WORD_MS));
      }
      await new Promise((resolve) => setTimeout(resolve, ENDPOINTING_MS));
      const finalAt = performance.now();
      deepgram.send({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: finalText }] } });
      // Espera o turno do agente acabar: o texto falado chega em `transcript` (agente) e o fim da síntese o fecha.
      const deadline = performance.now() + 30000;
      while (performance.now() < deadline && !(agentSaid.length > 0 && llmCalls.length > 0 && metrics.length > 0)) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const answer = agentSaid.join(" ").trim();
      const call = llmCalls.find((c) => c.knowledge !== undefined) ?? llmCalls[0];
      const metric = metrics[0];
      const retrievedText = (call?.knowledge?.hits ?? []).map((h) => input.chunkTextById.get(h.chunkId) ?? "").join("\n");
      const hasFacts = item.expected.length > 0;
      const verdict = answer === "" ? { ok: false, costUsd: 0 } : await judge(apiKey, { question: item.q, expected: item.expected, answer });
      const record: TurnRecord = {
        config: config.id,
        mode: config.mode,
        profile: config.profile,
        turn: index + 1,
        kind: item.kind,
        question: item.q,
        words: words.length,
        skippedByHeuristic: !needsKnowledge(finalText),
        retrievalVisibleMs: call?.knowledge?.mode === "rag" ? call.knowledge.retrievalMs : null,
        speculative: call?.knowledge?.mode === "rag" ? call.knowledge.speculative : null,
        usedVector: call?.knowledge?.mode === "rag" ? call.knowledge.usedVector : null,
        fallback: call?.knowledge?.fallback ?? null,
        hits: call?.knowledge?.mode === "rag" ? call.knowledge.hits.length : null,
        dbSearchMs: dbSearchLog.map((entry) => ({ vector: entry.vector, ms: round(entry.ms, 1) ?? 0 })),
        embedMs: embedLog.map((ms) => round(ms, 1) ?? 0),
        userEndToFirstTokenMs: firstTokenAt !== undefined ? round(firstTokenAt - finalAt) : null,
        modelFirstTokenMs: firstTokenAt !== undefined && chatStartedAt !== undefined ? round(firstTokenAt - chatStartedAt) : null,
        firstSentenceMs: firstSpeakAt !== undefined && chatStartedAt !== undefined ? round(firstSpeakAt - chatStartedAt) : null,
        rttMs: metric ? round(metric.rttMs) : null,
        promptTokens: call?.promptTokens ?? null,
        cachedTokens: call?.cachedTokens ?? null,
        completionTokens: call?.completionTokens ?? null,
        embeddingTokens: call?.knowledge?.embeddingTokens ?? null,
        costUsd: Math.round(usdThisTurn * 1e8) / 1e8,
        provider: call?.provider ?? null,
        answer,
        expected: item.expected,
        factInRetrieved: config.mode === "rag" && hasFacts ? item.expected.every((fact) => factInText(retrievedText, fact)) : null,
        factInAnswerText: hasFacts ? item.expected.every((fact) => factInText(answer, fact)) : false,
        judgeOk: verdict.ok,
      };
      spend(usdThisTurn);
      records.push(record);
      appendFileSync(path.join(input.out, "turnos.jsonl"), `${JSON.stringify(record)}\n`);
      if ((index + 1) % 10 === 0) note(`[${config.id}] ${index + 1}/${questions.length} · gasto acumulado US$ ${spentUsd.toFixed(4)}`);
    }
  } finally {
    ttsRunning = false;
    await session.close();
    await Promise.allSettled([deepgram.stop(), cartesia.stop()]);
  }
  return records;
}

function summarize(records: TurnRecord[], config: Config) {
  const mine = records.filter((r) => r.config === config.id);
  const warm = mine.filter((r) => r.turn > 1);
  const asked = mine.filter((r) => r.expected.length > 0);
  const outside = mine.filter((r) => r.expected.length === 0);
  const nums = (pick: (r: TurnRecord) => number | null, from = mine): number[] => from.map(pick).filter((v): v is number => v !== null);
  const embeds = mine.flatMap((r) => r.embedMs);
  const dbLex = mine.flatMap((r) => r.dbSearchMs.filter((s) => !s.vector).map((s) => s.ms));
  const dbVec = mine.flatMap((r) => r.dbSearchMs.filter((s) => s.vector).map((s) => s.ms));
  return {
    config: config.id,
    label: config.label,
    turns: mine.length,
    accuracy: { asked: asked.length, judged: asked.filter((r) => r.judgeOk).length, textMatch: asked.filter((r) => r.factInAnswerText).length, outsideBase: outside.length, outsideOk: outside.filter((r) => r.judgeOk).length },
    retrieved: config.mode === "rag" ? { factPresent: asked.filter((r) => r.factInRetrieved).length, of: asked.length } : null,
    retrievalVisibleMs: config.mode === "rag" ? { p50: percentile(nums((r) => r.retrievalVisibleMs), 50), p90: percentile(nums((r) => r.retrievalVisibleMs), 90), max: percentile(nums((r) => r.retrievalVisibleMs), 100) } : null,
    speculativeShare: config.mode === "rag" ? round(mine.filter((r) => r.speculative).length / Math.max(1, mine.length), 2) : null,
    vectorShare: config.mode === "rag" ? round(mine.filter((r) => r.usedVector).length / Math.max(1, mine.length), 2) : null,
    fallbacks: mine.filter((r) => r.fallback).length,
    dbLexicalMs: { p50: percentile(dbLex, 50), p90: percentile(dbLex, 90) },
    dbVectorMs: { p50: percentile(dbVec, 50), p90: percentile(dbVec, 90) },
    embedMs: { p50: percentile(embeds, 50), p90: percentile(embeds, 90) },
    modelFirstTokenMs: { p50: percentile(nums((r) => r.modelFirstTokenMs), 50), p90: percentile(nums((r) => r.modelFirstTokenMs), 90), warmP50: percentile(nums((r) => r.modelFirstTokenMs, warm), 50) },
    firstSentenceMs: { p50: percentile(nums((r) => r.firstSentenceMs), 50), p90: percentile(nums((r) => r.firstSentenceMs), 90) },
    userEndToFirstTokenMs: { p50: percentile(nums((r) => r.userEndToFirstTokenMs), 50), p90: percentile(nums((r) => r.userEndToFirstTokenMs), 90) },
    rttMs: { p50: percentile(nums((r) => r.rttMs), 50), p90: percentile(nums((r) => r.rttMs), 90) },
    promptTokensP50: percentile(nums((r) => r.promptTokens), 50),
    cachedShare: round(nums((r) => r.cachedTokens).reduce((a, b) => a + b, 0) / Math.max(1, nums((r) => r.promptTokens).reduce((a, b) => a + b, 0)), 2),
    costUsdPerTurn: round(mine.reduce((s, r) => s + r.costUsd, 0) / Math.max(1, mine.length), 6),
    costUsdTotal: round(mine.reduce((s, r) => s + r.costUsd, 0), 4),
  };
}

const fmt = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : String(n));

function table(rows: ReturnType<typeof summarize>[]): string {
  const head = "| Configuração | Acerto (juiz) | Acerto (texto) | Fora da base | Fato nos trechos | Espera pela busca p50/p90/máx (ms) | Especulativa | Com vetor | Modelo 1º token p50/p90 (ms) | 1ª frase p50/p90 (ms) | Fim da fala→1º token p50/p90 (ms) | Tokens entrada p50 | Cache | US$/turno |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const lines = rows.map((r) => {
    const a = r.accuracy;
    return `| ${r.label} | ${a.judged}/${a.asked} | ${a.textMatch}/${a.asked} | ${a.outsideOk}/${a.outsideBase} | ${r.retrieved ? `${r.retrieved.factPresent}/${r.retrieved.of}` : "—"} | ${r.retrievalVisibleMs ? `${fmt(r.retrievalVisibleMs.p50)}/${fmt(r.retrievalVisibleMs.p90)}/${fmt(r.retrievalVisibleMs.max)}` : "—"} | ${fmt(r.speculativeShare)} | ${fmt(r.vectorShare)} | ${fmt(r.modelFirstTokenMs.p50)}/${fmt(r.modelFirstTokenMs.p90)} | ${fmt(r.firstSentenceMs.p50)}/${fmt(r.firstSentenceMs.p90)} | ${fmt(r.userEndToFirstTokenMs.p50)}/${fmt(r.userEndToFirstTokenMs.p90)} | ${fmt(r.promptTokensP50)} | ${fmt(r.cachedShare)} | ${fmt(r.costUsdPerTurn)} |`;
  });
  return [head, ...lines].join("\n");
}

/** A hipótese do "Jev": um classificador (LLM) para decidir se a pergunta precisa de consulta, medido contra a busca. */
async function measureJev(apiKey: string, questions: Question[], out: string): Promise<void> {
  const fillers = ["ok", "sim", "tchau", "tá bom obrigado", "bom dia", "pode ser", "um momento", "não", "certo entendi", "onze nove nove nove nove oito oito oito"];
  // As perguntas (todas precisam de consulta) e as falas curtas (nenhuma precisa): o classificador e a heurística local erram em lados diferentes.
  const samples = [...questions.map((q) => q.q), ...fillers];
  const needs = [...questions.map(() => true), ...fillers.map(() => false)];
  const classifiers = [
    { id: "deepseek-v4.1-flash@together", model: "deepseek/deepseek-v4.1-flash", provider: ["together"], reasoning: { enabled: false } },
    { id: "gpt-oss-120b@cerebras", model: "openai/gpt-oss-120b", provider: ["cerebras"], reasoning: { effort: "low" } },
    { id: "haiku-5.5", model: "anthropic/claude-haiku-5.5", provider: undefined, reasoning: { enabled: false } },
  ];
  const result: Record<string, unknown> = {};
  for (const classifier of classifiers) {
    const latencies: number[] = [];
    let cost = 0;
    let falseNegatives = 0;
    let falsePositives = 0;
    for (const [index, sample] of samples.entries()) {
      if (spentUsd > Number(arg("budget") ?? "0.9")) break;
      const t0 = performance.now();
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: classifier.model,
          messages: [
            { role: "system", content: "Você decide se a fala de quem ligou para uma clínica odontológica precisa consultar a base de conhecimento (preços, horários, políticas, serviços, convênios). Responda só SIM ou NAO." },
            { role: "user", content: sample },
          ],
          // Modelo que raciocina gasta o teto no raciocínio: 8 tokens deixavam a resposta vazia.
          max_tokens: classifier.reasoning && "effort" in classifier.reasoning ? 200 : 8,
          temperature: 0,
          reasoning: classifier.reasoning,
          ...(classifier.provider && { provider: { order: classifier.provider, allow_fallbacks: true } }),
        }),
        signal: AbortSignal.timeout(20000),
      });
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number } };
      latencies.push(performance.now() - t0);
      cost += body.usage?.cost ?? 0;
      spend(body.usage?.cost ?? 0);
      const said = /\bsim\b/i.test(body.choices?.[0]?.message?.content ?? "");
      if (needs[index] && !said) falseNegatives += 1;
      if (!needs[index] && said) falsePositives += 1;
    }
    result[classifier.id] = {
      calls: latencies.length,
      totalLatencyMs: { p50: round(percentile(latencies, 50)), p90: round(percentile(latencies, 90)) },
      costUsdPerCall: round(cost / Math.max(1, latencies.length), 8),
      // Falso negativo = pergunta que precisava da base e o classificador mandou responder sem ela (o agente erra ou inventa).
      falseNegatives: `${falseNegatives}/${needs.filter(Boolean).length}`,
      falsePositives: `${falsePositives}/${needs.filter((n) => !n).length}`,
    };
  }
  const heuristic = samples.map((s) => needsKnowledge(s));
  const heuristicTimes = samples.map((sample) => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) needsKnowledge(sample);
    return (performance.now() - t0) / 1000;
  });
  result["heuristica-local"] = {
    calls: samples.length,
    latencyMsP90: round(percentile(heuristicTimes, 90), 4),
    costUsdPerCall: 0,
    falseNegatives: `${samples.filter((_, i) => needs[i] && !heuristic[i]).length}/${needs.filter(Boolean).length}`,
    falsePositives: `${samples.filter((_, i) => !needs[i] && heuristic[i]).length}/${needs.filter((n) => !n).length}`,
  };
  writeFileSync(path.join(out, "jev.json"), `${JSON.stringify(result, null, 2)}\n`);
}

async function main(): Promise<void> {
  if (!flag("live")) throw new Error("Use --live para medir serviços pagos (OpenRouter).");
  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const out = path.resolve(arg("out") ?? path.join(process.env.HOME ?? ".", "agent-state/entregas/ozavo-base-conhecimento-25nov/medicoes-voz"));
  mkdirSync(out, { recursive: true });
  const limit = Number(arg("limit") ?? "40");
  const wanted = arg("configs")?.split(",");
  const configs = CONFIGS.filter((c) => !wanted || wanted.includes(c.id));
  const questions = (JSON.parse(readFileSync(path.join(DATA, "perguntas.json"), "utf8")) as Question[]).slice(0, limit);
  if (flag("jev-only")) {
    await measureJev(apiKey, questions, out);
    note(readFileSync(path.join(out, "jev.json"), "utf8"));
    return;
  }
  const manual = readFileSync(path.join(DATA, "manual-sorriso-verde.md"), "utf8");

  const { app, owner } = await openDatabases();
  try {
    const organizationId = crypto.randomUUID();
    await withSystem(app, (q) => q.exec("insert into organizations (id, name) values ($1, 'bancada conhecimento voz')", [organizationId]));
    const now = systemClock.now();
    // Indexa a base como a rotina faz (com o título da seção junto do texto do embedding), com embeddings reais.
    const indexStart = performance.now();
    const sourceId = await withOrg(app, organizationId, async (q) => {
      const created = await createKnowledgeSource(q, { name: "Manual Sorriso Verde", kind: "text", text: manual, createdBy: null, now });
      const claimed = await claimKnowledgeVersion(q, created.versionId, now);
      if (!claimed) throw new Error("versão não reivindicada");
      const chunks = chunkText(manual);
      const inputs = chunks.map((chunk) => (chunk.section && !chunk.content.startsWith(chunk.section) ? `${chunk.section}\n${chunk.content}` : chunk.content));
      const embedded = await embedTexts(inputs, { apiKey, attempts: 2 }, chunks.map((chunk) => chunk.tokenCount));
      spend(embedded.costMicrocents / 1e8);
      await completeKnowledgeVersion(q, {
        versionId: created.versionId,
        sourceId: created.sourceId,
        text: manual,
        chunks: chunks.map((chunk, i) => ({ ...chunk, embedding: embedded.vectors[i] ?? [] })),
        tokenCount: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
        embeddingTokens: embedded.tokens,
        costMicrocents: embedded.costMicrocents,
        now,
      });
      writeFileSync(path.join(out, "indexacao.json"), `${JSON.stringify({ chunks: chunks.length, tokens: chunks.reduce((s, c) => s + c.tokenCount, 0), embeddingTokens: embedded.tokens, costUsd: embedded.costMicrocents / 1e8, ms: round(performance.now() - indexStart), characters: manual.length }, null, 2)}\n`);
      return created.sourceId;
    });
    const chunkTextById = new Map<string, string>();
    const chunkRows = await withOrg(app, organizationId, (q) => q.many<{ id: string; content: string }>("select id, content from knowledge_chunks where source_id = $1", [sourceId]));
    for (const row of chunkRows) chunkTextById.set(row.id, row.content);

    // Um agente por configuração (o modo é do agente), todos ligados à mesma base e "responder só pela base".
    const agents = new Map<string, string>();
    for (const config of configs) {
      const agentId = crypto.randomUUID();
      await withSystem(app, (q) => q.exec("insert into agents (id, organization_id, name, engine, instructions) values ($1, $2, $3, 'deepgram-openrouter-cartesia', $4)", [agentId, organizationId, config.id, AGENT_INSTRUCTIONS]));
      await withOrg(app, organizationId, (q) => setAgentKnowledge(q, agentId, { sourceIds: [sourceId], mode: config.mode as KnowledgeMode, only: true }, now));
      agents.set(config.id, agentId);
    }
    note(`base indexada: ${chunkRows.length} trechos; gasto até aqui US$ ${spentUsd.toFixed(5)}; configurações: ${configs.map((c) => c.id).join(", ")}`);

    const all = await Promise.all(configs.map((config) => runConfig({ config, questions, apiKey, app, organizationId, agentId: agents.get(config.id) ?? "", chunkTextById, out }).catch((error: unknown) => {
      note(`[${config.id}] falhou: ${error instanceof Error ? error.message : "erro"}`);
      return [] as TurnRecord[];
    })));
    const records = all.flat();
    const summaries = configs.map((config) => summarize(records, config));
    writeFileSync(path.join(out, "resumo.json"), `${JSON.stringify({ spentUsd: round(spentUsd, 4), questions: questions.length, summaries }, null, 2)}\n`);
    writeFileSync(path.join(out, "tabela.md"), `${table(summaries)}\n`);
    if (flag("jev")) await measureJev(apiKey, questions, out);
    note(`\nconcluído; gasto total US$ ${spentUsd.toFixed(4)}\n${table(summaries)}`);
  } finally {
    await app.close();
    await owner.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Bancada falhou: ${error instanceof Error ? error.message : "erro"}. Nenhum segredo foi registrado.\n`);
  process.exitCode = 1;
});
