// Semente da base de conhecimento da demonstração: fontes em todos os estados (pronta, indexando, na fila,
// com versão nova esperando, falhas), embeddings falsos e a chave do OpenRouter de mentira, para tirar prints
// e usar a tela sem chamar provedor nenhum. Roda DEPOIS de seed-demo.ts, na mesma organização. Dados inventados.
//
//   DATABASE_URL=... SYSTEM_DATABASE_URL=... OZAVO_SECRET_KEY=... pnpm --filter @ozavo/panel exec tsx scripts/seed-knowledge-demo.ts
import {
  chunkText,
  claimKnowledgeVersion,
  completeKnowledgeVersion,
  createDb,
  createKnowledgeSource,
  encryptSecret,
  failKnowledgeVersion,
  loadConfig,
  replaceKnowledgeSource,
  setAgentKnowledge,
  systemClock,
  withOrg,
  withSystem,
  type OrgQuery,
} from "@ozavo/core";
import { createHash } from "node:crypto";

const config = loadConfig({ ...process.env, PUBLIC_URL: "http://127.0.0.1:3080", ARI_PASSWORD: "demo" });
const db = createDb(config.databaseUrl, config.systemDatabaseUrl);
const now = systemClock.now();
const ago = (minutes: number): Date => new Date(now.getTime() - minutes * 60_000);

/** O mesmo embedding de mentira dos testes (`packages/core/test/fake-embeddings.ts`), sem importar de pasta de teste. */
const normalize = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function embed(text: string): number[] {
  const vector = new Array<number>(1536).fill(0);
  for (const word of normalize(text).match(/[a-z0-9]{3,}/g) ?? []) {
    const slot = createHash("sha1").update(word).digest().readUInt16BE(0) % 1536;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

const PRICES = [
  "# Preços",
  "A consulta de avaliação custa cento e cinquenta reais e dura cerca de quarenta minutos. O retorno em até trinta dias não tem custo.",
  "A limpeza com profilaxia custa duzentos reais. O clareamento a laser custa novecentos reais, em até seis vezes no cartão.",
  "# Formas de pagamento",
  "Aceitamos cartão de crédito e débito, Pix e dinheiro. Não aceitamos cheque.",
].join("\n\n");
const HOURS = [
  "# Horários de atendimento",
  "A clínica atende de segunda a sexta, das oito às dezoito horas, e aos sábados até o meio-dia. Não abrimos aos domingos nem em feriados nacionais.",
  "# Endereço",
  "Rua das Acácias, 120, sala 4, bairro Savassi, Belo Horizonte. Há estacionamento conveniado na mesma quadra.",
].join("\n\n");
const CANCEL = [
  "# Cancelamento e remarcação",
  "O cancelamento deve ser avisado com pelo menos um dia de antecedência, pelo telefone ou pelo WhatsApp. A remarcação não tem custo quando avisada no prazo.",
  "Faltas sem aviso são registradas e, na terceira falta seguida, a próxima consulta exige confirmação no dia anterior.",
].join("\n\n");
const BIG = Array.from({ length: 70 }, (_, i) => `# Procedimento ${i + 1}\n\nO procedimento ${i + 1} começa com a avaliação do paciente, passa pela explicação do plano de tratamento e termina com o registro das orientações de cuidado em casa. O retorno é combinado no fim da consulta.`).join("\n\n");

const organizationId = await withSystem(db, async (q) => {
  const row = await q.one<{ id: string }>("select organization_id as id from users where email = 'demo@ozavo.test'");
  if (!row) throw new Error("Run seed-demo.ts first: demo@ozavo.test does not exist.");
  return row.id;
});

await withOrg(db, organizationId, async (q: OrgQuery) => {
  const fresh = (await q.one("select 1 from knowledge_sources limit 1")) === null;
  const create = (name: string, kind: "pdf" | "docx" | "md" | "txt" | "text", at: Date, filename: string | null, text: string) =>
    createKnowledgeSource(q, { name, kind, filename, ...(kind === "text" ? { text } : { raw: Buffer.from(text) }), createdBy: null, now: at });
  const ready = async (created: { sourceId: string; versionId: string }, text: string, at: Date, costMicrocents: number): Promise<void> => {
    const claimed = await claimKnowledgeVersion(q, created.versionId, at);
    if (!claimed) throw new Error("not claimed");
    const chunks = chunkText(text);
    await completeKnowledgeVersion(q, {
      versionId: created.versionId,
      sourceId: created.sourceId,
      text,
      chunks: chunks.map((chunk) => ({ ...chunk, embedding: embed(`${chunk.section ?? ""} ${chunk.content}`) })),
      tokenCount: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
      embeddingTokens: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
      costMicrocents,
      now: at,
    });
  };

  if (fresh) await seedAll();
  async function seedAll(): Promise<void> {
    const prices = await create("Tabela de preços", "text", ago(60 * 26), null, PRICES);
    await ready(prices, PRICES, ago(60 * 26), 3_000);
    const hours = await create("Horários e endereço", "md", ago(60 * 24), "horarios.md", HOURS);
    await ready(hours, HOURS, ago(60 * 24), 2_400);
    const manual = await create("Manual de procedimentos", "pdf", ago(60 * 5), "manual-de-procedimentos.pdf", BIG);
    await ready(manual, BIG, ago(60 * 5), 190_000);

    // Pronta, com uma versão nova esperando (continua respondendo a anterior).
    const cancel = await create("Política de cancelamento", "docx", ago(60 * 3), "politica-de-cancelamento.docx", CANCEL);
    await ready(cancel, CANCEL, ago(60 * 3), 2_000);
    await replaceKnowledgeSource(q, cancel.sourceId, { kind: "docx", filename: "politica-de-cancelamento-v2.docx", raw: Buffer.from(CANCEL), createdBy: null, now: ago(1) });

    // Indexando agora e na fila.
    const indexing = await create("Convênios aceitos", "pdf", ago(2), "convenios.pdf", HOURS);
    await claimKnowledgeVersion(q, indexing.versionId, ago(1));
    await create("Perguntas frequentes", "text", ago(1), null, CANCEL);

    // Falhas, cada uma com a frase do motivo.
    const scanned = await create("Contrato assinado (digitalizado)", "pdf", ago(60 * 2), "contrato.pdf", HOURS);
    await claimKnowledgeVersion(q, scanned.versionId, ago(60 * 2));
    await failKnowledgeVersion(q, scanned.versionId, "scanned_pdf", ago(60 * 2));
    const key = await create("Guia do paciente", "docx", ago(60), "guia-do-paciente.docx", HOURS);
    await claimKnowledgeVersion(q, key.versionId, ago(60));
    await failKnowledgeVersion(q, key.versionId, "embedding_rejected", ago(60), HOURS);

    // O agente Lia usa duas bases, no modo automático.
    const lia = await q.one<{ id: string }>("select id from agents where name = 'Lia'");
    if (lia) await setAgentKnowledge(q, lia.id, { sourceIds: [prices.sourceId, hours.sourceId], mode: "auto", only: false }, now);
    await setAgentKnowledge(q, (await q.one<{ id: string }>("select id from agents where name = 'Caio'"))?.id ?? "", { sourceIds: [prices.sourceId], mode: "rag", only: true }, now);

  }
  // Uma base maior que o teto da base inteira no prompt (6.000 tokens), para ver o aviso na tela do agente.
  if (!(await q.one("select 1 from knowledge_sources where name = 'Catálogo de serviços'"))) {
    const catalog = `${BIG}\n\n${BIG.replaceAll('Procedimento', 'Serviço')}`;
    await ready(await create("Catálogo de serviços", "pdf", ago(30), "catalogo.pdf", catalog), catalog, ago(30), 380_000);
  }
  // A chave do OpenRouter de mentira do motor em pipeline, cifrada como a de verdade.
  await q.exec("insert into settings (organization_id, key, value) values ($1, 'engine.deepgram-openrouter-cartesia.api_key', to_jsonb($2::text)) on conflict (organization_id, key) do nothing", [
    organizationId,
    encryptSecret(JSON.stringify({ deepgram: "demo", cartesia: "demo", openrouter: "demo-openrouter" }), config.secretKey),
  ]);
});
await db.close();
process.stdout.write("Knowledge demo seeded.\n");
