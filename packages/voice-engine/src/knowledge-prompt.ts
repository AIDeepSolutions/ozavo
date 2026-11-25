import type { KnowledgeSearchHit } from "./types";

/**
 * O texto da base de conhecimento que vai ao modelo, num lugar só: a seção fixa do prompt de sistema
 * (instrução de uso e, no modo "base inteira", os documentos) e o bloco por turno do modo de busca
 * (os trechos recuperados para a última fala da pessoa).
 *
 * Duas regras de forma, ambas cobradas por teste:
 *   - a seção fixa é DETERMINÍSTICA (documentos por nome e id, sem data nem contagem que mude):
 *     o prefixo do prompt precisa ser idêntico byte a byte entre turnos e entre ligações do mesmo agente,
 *     senão o cache do provedor erra e a primeira resposta de cada ligação paga o prompt inteiro;
 *   - o bloco por turno nunca entra no prefixo: vai logo antes da última fala da pessoa e não fica no
 *     histórico, então nada se acumula de um turno para o outro.
 *
 * Nenhum texto daqui carrega dado da conversa.
 */

export type KnowledgeLanguage = "pt" | "en" | "es";

export function knowledgeLanguageOf(language: string): KnowledgeLanguage {
  const base = language.split("-")[0]?.toLowerCase();
  return base === "pt" || base === "es" ? base : "en";
}

/** Teto do bloco de trechos de um turno, em tokens (estimativa do banco, por trecho). */
export const CONTEXT_MAX_TOKENS = 1500;
/** Quantos trechos entram por turno, quando o agente não define. */
export const DEFAULT_TOP_K = 4;

interface Wording {
  heading: string;
  /** Como usar o conhecimento (vale para a base inteira e para os trechos). */
  use: string;
  /** Só no modo de busca: de onde vêm os trechos. */
  retrieved: string;
  /** Com "responder só pela base". */
  only: string;
  contextHeader: string;
  contextNone: string;
}

const WORDING: Record<KnowledgeLanguage, Wording> = {
  pt: {
    heading: "Base de conhecimento",
    use:
      "Use o conhecimento da empresa abaixo para responder, mas só o que for relevante para o que a pessoa perguntou. " +
      "Nunca leia códigos, números de fonte ou títulos de seção em voz alta e nunca diga \"segundo a base\" ou \"no documento\": fale natural, como quem conhece o assunto. " +
      "Valores, horários, prazos e regras saem exatamente como estão escritos, sem arredondar nem completar.",
    retrieved:
      "A cada pergunta, antes da última fala da pessoa, o sistema pode enviar uma mensagem com os trechos da base mais próximos dela. Use-os só se forem relevantes e ignore-os se não forem; trechos antigos não valem para a pergunta seguinte.",
    only:
      "Responda apenas com o que está na base. Se a informação não estiver nela, diga com naturalidade que não tem essa informação e ofereça anotar um recado ou transferir para uma pessoa, usando as ferramentas disponíveis quando houver. Nunca invente nem complete com o que você supõe.",
    contextHeader: "Trechos da base de conhecimento para a última fala da pessoa (não leia ids nem diga que vieram da base):",
    contextNone: "Base de conhecimento: nenhum trecho relevante foi encontrado para a última fala da pessoa.",
  },
  en: {
    heading: "Knowledge base",
    use:
      "Use the company knowledge below to answer, but only what is relevant to what the person asked. " +
      "Never read codes, source numbers or section titles aloud and never say \"according to the knowledge base\" or \"in the document\": speak naturally, like someone who knows the subject. " +
      "Prices, hours, deadlines and rules come out exactly as written, without rounding or filling in.",
    retrieved:
      "For each question, right before the person's last turn, the system may send a message with the knowledge base passages closest to it. Use them only if they are relevant and ignore them if they are not; old passages do not apply to the next question.",
    only:
      "Answer only with what is in the knowledge base. If the information is not there, say naturally that you do not have it and offer to take a message or transfer to a person, using the available tools when there are any. Never make things up or fill gaps with guesses.",
    contextHeader: "Knowledge base passages for the person's last turn (do not read ids or say they came from the knowledge base):",
    contextNone: "Knowledge base: no relevant passage was found for the person's last turn.",
  },
  es: {
    heading: "Base de conocimiento",
    use:
      "Usa el conocimiento de la empresa que sigue para responder, pero solo lo que sea relevante para lo que la persona preguntó. " +
      "Nunca leas códigos, números de fuente o títulos de sección en voz alta y nunca digas \"según la base\" o \"en el documento\": habla natural, como quien conoce el tema. " +
      "Valores, horarios, plazos y reglas salen exactamente como están escritos, sin redondear ni completar.",
    retrieved:
      "Con cada pregunta, justo antes de la última intervención de la persona, el sistema puede enviar un mensaje con los fragmentos de la base más cercanos a ella. Úsalos solo si son relevantes e ignóralos si no lo son; los fragmentos antiguos no valen para la pregunta siguiente.",
    only:
      "Responde solo con lo que está en la base. Si la información no está, di con naturalidad que no la tienes y ofrece anotar un recado o transferir a una persona, usando las herramientas disponibles cuando las haya. Nunca inventes ni completes con suposiciones.",
    contextHeader: "Fragmentos de la base de conocimiento para la última intervención de la persona (no leas ids ni digas que vienen de la base):",
    contextNone: "Base de conocimiento: no se encontró ningún fragmento relevante para la última intervención de la persona.",
  },
};

export interface KnowledgeDocument {
  id: string;
  name: string;
  text: string;
}

/**
 * A seção fixa do prompt de sistema. `documents` só no modo "base inteira"; no modo de busca vai só a
 * instrução (estável por agente). Ordem dos documentos: nome e id, sempre a mesma.
 */
export function knowledgeSystemSection(input: { mode: "full" | "rag"; only: boolean; language: string; documents?: readonly KnowledgeDocument[] }): string {
  const w = WORDING[knowledgeLanguageOf(input.language)];
  const parts = [`## ${w.heading}`, w.use];
  if (input.mode === "rag") parts.push(w.retrieved);
  if (input.only) parts.push(w.only);
  if (input.mode === "full") {
    const ordered = [...(input.documents ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const doc of ordered) parts.push(`### ${doc.name}\n${doc.text.trim()}`);
  }
  return parts.join("\n\n");
}

/** Um trecho como o modelo o lê: de onde veio (fonte e seção) e o texto. Sem id, sem pontuação. */
function renderHit(hit: KnowledgeSearchHit, content: string): string {
  const label = hit.section ? `${hit.sourceName} › ${hit.section}` : hit.sourceName;
  return `[${label}]\n${content.trim()}`;
}

/** O truncamento de um trecho só acontece quando ele sozinho passa do teto: corta em palavra. */
function truncateToTokens(text: string, tokens: number): string {
  const characters = Math.max(200, Math.floor(tokens * 3.5));
  if (text.length <= characters) return text;
  const cut = text.lastIndexOf(" ", characters);
  return `${text.slice(0, cut > characters / 2 ? cut : characters).trimEnd()}…`;
}

export interface RetrievedContext {
  /** O texto da mensagem, ou `undefined` quando não há o que dizer (sem trechos e sem "só pela base"). */
  text: string | undefined;
  /** Os trechos que couberam no teto, na ordem em que entraram. */
  used: KnowledgeSearchHit[];
}

/**
 * A mensagem do turno: os trechos que couberam em `maxTokens`, do mais bem pontuado ao menos. Sem trecho,
 * e com "responder só pela base", a mensagem diz que não achou nada (o modelo precisa saber, para não
 * completar de cabeça); sem trecho e sem essa regra, não há mensagem.
 */
export function formatRetrievedContext(hits: readonly KnowledgeSearchHit[], input: { language: string; only: boolean; maxTokens?: number }): RetrievedContext {
  const w = WORDING[knowledgeLanguageOf(input.language)];
  const maxTokens = input.maxTokens ?? CONTEXT_MAX_TOKENS;
  const used: KnowledgeSearchHit[] = [];
  const rendered: string[] = [];
  let tokens = 0;
  for (const hit of hits) {
    const remaining = maxTokens - tokens;
    if (remaining <= 0) break;
    const fits = hit.tokenCount <= remaining;
    if (!fits && used.length > 0) continue; // um trecho grande não tira os menores que ainda cabem
    rendered.push(renderHit(hit, fits ? hit.content : truncateToTokens(hit.content, remaining)));
    used.push(hit);
    tokens += Math.min(hit.tokenCount, remaining);
  }
  if (rendered.length === 0) return { text: input.only ? w.contextNone : undefined, used };
  return { text: `${w.contextHeader}\n\n${rendered.join("\n\n")}`, used };
}
