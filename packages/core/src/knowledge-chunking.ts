import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";

/**
 * Parte o texto de um documento em trechos para a busca: por parágrafo e por seção, com ~250 a 400
 * tokens cada e uma pequena sobreposição dentro da mesma seção. Pura e sem relógio nem rede: o que
 * entra é texto, o que sai são trechos com a contagem de tokens do tokenizer do modelo de embedding
 * (`cl100k_base`, o do `text-embedding-3-small`).
 */

/** Alvo de tamanho de um trecho, em tokens. */
export const CHUNK_MIN_TOKENS = 250;
export const CHUNK_MAX_TOKENS = 400;
/** Quanto do fim de um trecho volta no começo do seguinte, na mesma seção. */
export const CHUNK_OVERLAP_TOKENS = 40;
/** Uma seção que sobraria com menos que isto se junta à vizinha. */
const SECTION_MIN_TOKENS = 120;
/** O último trecho que sobraria menor que isto se junta ao anterior. */
const TAIL_MIN_TOKENS = 60;

export interface TextChunk {
  position: number;
  /** O título da seção, quando o documento tem. */
  section: string | null;
  content: string;
  tokenCount: number;
}

let encoder: Tiktoken | undefined;
const tokenizer = (): Tiktoken => (encoder ??= new Tiktoken(cl100k));

/** Tokens do texto no tokenizer do modelo de embedding. */
export function countTokens(text: string): number {
  return text === "" ? 0 : tokenizer().encode(text).length;
}

/** Texto sem acento e em minúsculas: é o que a busca por palavras grava e consulta. */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Palavras que não ajudam a achar nada. O Postgres tira as dele no `portuguese`, mas sobre texto sem
// acento (`nao`, `voce`) a lista dele não casa, então a consulta tira estas antes.
const STOP_WORDS = new Set(
  "a o as os um uma uns umas de do da dos das em no na nos nas por para pra pro com sem e ou que se ao aos como mais mas ser sao foi tem ter voce voces eu me meu minha seu sua seus suas isso esse essa este esta estao quando qual quais quanto quantos quantas onde oi ola bom boa dia tarde noite ai la aqui tambem ja so ate sobre entre ainda depois antes muito pouco tudo nada algo alguem ninguem quero queria gostaria saber posso pode podem poderia preciso precisa".split(
    " ",
  ),
);

/**
 * A consulta da busca por palavras: os termos da pergunta ligados por OU (`to_tsquery`), sem acento e
 * sem palavra vazia. `null` quando não sobra termo nenhum (a busca por palavras não tem o que fazer).
 */
export function buildTsQuery(question: string, maxTerms = 24): string | null {
  const terms = [
    ...new Set(
      (normalizeSearchText(question).match(/[a-z0-9]{2,}/g) ?? []).filter((term) => !STOP_WORDS.has(term)),
    ),
  ].slice(0, maxTerms);
  return terms.length === 0 ? null : terms.join(" | ");
}

const MARKDOWN_HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const NUMBERED_HEADING = /^(?:capítulo\s+)?\d{1,2}(?:\.\d{1,2}){0,3}[.)]?\s+\S.{0,90}$/i;

/** A linha é um título de seção? Devolve o texto do título. */
function headingOf(line: string): string | null {
  const text = line.trim();
  if (text === "" || text.length > 100) return null;
  const markdown = MARKDOWN_HEADING.exec(text);
  if (markdown?.[1]) return markdown[1].trim();
  // Título numerado ("3. Política de cancelamento") sem ponto final nem vírgula no fim.
  if (NUMBERED_HEADING.test(text) && !/[.,;:]$/.test(text) && !/^\d+[.,]\d{2}\b/.test(text)) return text;
  // Linha curta inteira em maiúsculas.
  if (text.length >= 4 && text.length <= 80 && text === text.toUpperCase() && /\p{L}{3}/u.test(text) && !/[.,;:]$/.test(text)) return text;
  return null;
}

interface Block {
  section: string | null;
  text: string;
  tokens: number;
  heading: boolean;
}

/** Quebra um texto sem linha em branco em sentenças. */
const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?…])\s+/).map((part) => part.trim()).filter((part) => part !== "");

/** Corte duro por palavras, para uma sentença maior que o máximo (uma tabela longa, por exemplo). */
function splitByWords(text: string, maxTokens: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const parts: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const word of words) {
    const cost = countTokens(`${word} `);
    if (tokens + cost > maxTokens && current.length > 0) {
      parts.push(current.join(" "));
      current = [];
      tokens = 0;
    }
    current.push(word);
    tokens += cost;
  }
  if (current.length > 0) parts.push(current.join(" "));
  return parts;
}

function toBlocks(text: string): Block[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n\n").replace(/[ \t]+\n/g, "\n");
  const blocks: Block[] = [];
  let section: string | null = null;
  for (const raw of normalized.split(/\n{2,}/)) {
    // Dentro do parágrafo, uma linha que é título abre uma seção nova.
    let pending: string[] = [];
    const flush = (): void => {
      const paragraph = pending.join("\n").trim();
      pending = [];
      if (paragraph === "") return;
      const tokens = countTokens(paragraph);
      if (tokens <= CHUNK_MAX_TOKENS) {
        blocks.push({ section, text: paragraph, tokens, heading: false });
        return;
      }
      // Parágrafo maior que o máximo: sentenças, e palavras quando nem a sentença cabe.
      let group: string[] = [];
      let groupTokens = 0;
      const push = (): void => {
        if (group.length > 0) blocks.push({ section, text: group.join(" "), tokens: groupTokens, heading: false });
        group = [];
        groupTokens = 0;
      };
      for (const sentence of sentencesOf(paragraph)) {
        const pieces = countTokens(sentence) > CHUNK_MAX_TOKENS ? splitByWords(sentence, CHUNK_MAX_TOKENS) : [sentence];
        for (const piece of pieces) {
          const cost = countTokens(`${piece} `);
          if (groupTokens + cost > CHUNK_MAX_TOKENS) push();
          group.push(piece);
          groupTokens += cost;
        }
      }
      push();
    };
    for (const line of raw.split("\n")) {
      const heading = headingOf(line);
      if (heading !== null) {
        flush();
        section = heading;
        blocks.push({ section, text: heading, tokens: countTokens(heading), heading: true });
      } else {
        pending.push(line);
      }
    }
    flush();
  }
  return blocks;
}

/** O fim de um trecho que volta no começo do seguinte: as últimas sentenças até `CHUNK_OVERLAP_TOKENS`. */
function overlapOf(text: string): string {
  const sentences = sentencesOf(text);
  const kept: string[] = [];
  let tokens = 0;
  for (const sentence of sentences.reverse()) {
    const cost = countTokens(sentence);
    if (tokens + cost > CHUNK_OVERLAP_TOKENS) break;
    kept.unshift(sentence);
    tokens += cost;
  }
  return kept.join(" ");
}

/**
 * Trechos do documento, na ordem em que ele aparece. Os parágrafos se juntam até ~400 tokens; o título
 * de uma seção abre trecho novo quando o que vinha já tem o tamanho mínimo da seção, senão fica com o
 * vizinho. Texto vazio devolve lista vazia.
 */
export function chunkText(text: string): TextChunk[] {
  const blocks = toBlocks(text);
  const chunks: TextChunk[] = [];
  let parts: string[] = [];
  let tokens = 0;
  let section: string | null = null;
  let lastEmittedText = "";

  const emit = (): void => {
    const content = parts.join("\n\n").trim();
    if (content !== "") {
      chunks.push({ position: chunks.length, section, content, tokenCount: countTokens(content) });
      lastEmittedText = content;
    }
    parts = [];
    tokens = 0;
  };

  for (const block of blocks) {
    const sameSection = block.section === section;
    const startsSection = block.heading && block.text === block.section;
    if (parts.length > 0 && ((startsSection && !sameSection && tokens >= SECTION_MIN_TOKENS) || tokens + block.tokens > CHUNK_MAX_TOKENS)) {
      const continues = sameSection && !startsSection;
      emit();
      // Sobreposição só quando o texto continua na mesma seção.
      if (continues) {
        const overlap = overlapOf(lastEmittedText);
        if (overlap !== "" && countTokens(overlap) + block.tokens <= CHUNK_MAX_TOKENS) {
          parts.push(overlap);
          tokens += countTokens(overlap);
        }
      }
    }
    if (parts.length === 0) section = block.section;
    parts.push(block.text);
    tokens += block.tokens;
  }
  emit();

  // O último trecho pequeno demais se junta ao anterior, desde que caiba.
  const last = chunks.at(-1);
  const previous = chunks.at(-2);
  if (last && previous && last.tokenCount < TAIL_MIN_TOKENS && previous.tokenCount + last.tokenCount <= CHUNK_MAX_TOKENS + TAIL_MIN_TOKENS && previous.section === last.section) {
    chunks.pop();
    const content = `${previous.content}\n\n${last.content}`;
    chunks[chunks.length - 1] = { ...previous, content, tokenCount: countTokens(content) };
  }
  return chunks;
}
