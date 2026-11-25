# 0022: Base de conhecimento (RAG) do agente de voz

- **Estado:** aceita
- **Data:** 2026-11-25
- **Quem decidiu:** o dono do projeto, que pediu a base de conhecimento com busca por similaridade
  para o agente usar a favor dele, e o autor, nos detalhes abaixo.
- **Estado do produto:** validado em bancada e em chamada simulada. Nenhuma ligação real passou por esta peça.

## Contexto

O agente só sabia o que cabia nas instruções. Uma empresa com tabela de preços, convênios, políticas e
FAQ (30 a 40 páginas, ~32 mil tokens) não consegue pôr isso no prompt sem pagar a cada ligação e sem
perder velocidade. O pedido: o agente consulta a base durante a ligação, sem somar latência perceptível.

Medidas que decidiram o desenho (bancada de 25/11/2026, benchmark de prompt pesado
e esta implementação):

- A extensão `vector` (pgvector 0.8.2) está disponível no Supabase de produção (conferido em
  `pg_available_extensions`, Postgres 17.11).
- Embedding de uma pergunta pelo OpenRouter (`openai/text-embedding-3-small`, 1536 dimensões): mediana
  de 455 ms, p90 508 ms, medido desta VPS. Custa US$ 0,02 por milhão de tokens (~US$ 0,0000003 por pergunta).
- Busca por palavras sobre os 42 trechos reais da AI Deep Solutions: 0,02 ms e 8 de 10 fatos achados; a
  busca por similaridade com o mesmo modelo achou 8 a 9 de 10; a fusão das duas ficou igual ou melhor.
- O round-trip ao Supabase é ~9 ms.

## Decisão

1. **pgvector no Postgres do Ozavo**, sem banco vetorial separado. Tabelas por empresa com RLS no padrão
   do projeto: `knowledge_sources` (fonte), `knowledge_versions` (cada indexação), `knowledge_chunks`
   (`embedding vector(1536)`, `tsv` gerado, `token_count`, seção), `agent_knowledge_sources` (uma base serve
   vários agentes; um agente usa várias bases) e `knowledge_usage` (custo de indexação e de busca de teste).
2. **A imagem do Postgres do Compose, do CI e do `test-db.sh` passa a ser a do pgvector** (Debian, glibc),
   fixada por resumo. No Supabase nada muda. **Quem já instalou pelo Compose** troca de Alpine (musl) para
   Debian (glibc): a ordenação de texto pode divergir nos índices existentes, e a nota da versão manda
   rodar `reindex database` uma vez. O atualizador sobe o banco com a imagem nova antes das migrations.
   Alternativa descartada: construir e publicar uma imagem própria do Postgres em Alpine com pgvector, que
   evitaria a troca de libc mas criaria uma peça a mais para manter e publicar.
3. **Embeddings pelo OpenRouter**, com a chave do motor em pipeline da própria empresa (a mesma do modelo
   de texto): não há segredo novo e a configuração continua tendo tela. O modelo fica gravado por versão.
   Outro modelo de 1536 dimensões entra sem migration; de outro tamanho, com migration nova.
4. **Chunking por parágrafo e seção**, de 250 a 400 tokens, sobreposição de ~40 tokens dentro da mesma
   seção, título da seção junto do texto do embedding. Contagem de tokens com `cl100k_base`, o tokenizer do
   modelo de embedding.
5. **Busca híbrida em uma consulta só**: os 12 melhores por similaridade de cosseno e os 12 melhores por
   palavras (`to_tsquery('portuguese')` sobre texto sem acento), fundidos por posição (RRF). Trecho que só a
   similaridade achou, com cosseno abaixo de 0,22, é descartado. A busca é **exata** (sem índice HNSW): o
   filtro por fontes do agente é seletivo, e o filtro depois do índice aproximado devolveria menos trechos
   que o pedido. O HNSW com varredura iterativa entra quando uma empresa passar de ~50 mil trechos.
6. **Versões.** Reindexar ou trocar o arquivo cria uma versão; a fonte continua respondendo com a
   anterior até a nova ficar pronta, e só então os trechos antigos saem. O arquivo enviado vive só até a
   extração; o texto extraído fica, para reindexar sem novo envio.
7. **Indexação fora do painel**: o painel grava a fonte e enfileira `index_knowledge`; a rotina extrai
   (PDF com `unpdf`, DOCX com `mammoth`, texto em UTF-8 ou Windows-1252), parte, pede os embeddings e grava
   numa transação. Falha que não adianta repetir (arquivo ilegível, PDF só de imagem, teto, sem chave, chave
   recusada) marca a versão com um código fechado (`KNOWLEDGE_ERROR_CODES`) e encerra a tarefa; falha de rede
   ou limite do provedor devolve a tarefa à fila, e só a última tentativa marca a falha.
8. **Tetos** (`KNOWLEDGE_LIMITS`): 20 MB por arquivo, 1 milhão de tokens por fonte, 5 milhões de tokens por
   empresa, 200 fontes. Indexar o teto inteiro de uma empresa custa US$ 0,10 (5 milhões × US$ 0,02 por
   milhão). Texto de ~32 mil tokens: US$ 0,00064.
9. **Modos do agente** (`agents.knowledge_mode`): `auto` (base inteira no prompt se as bases do agente somam
   até 6.000 tokens, senão busca por pergunta), `rag` e `full`. `agents.knowledge_only` manda responder só
   pelo que está na base.
10. **Custo.** A indexação e a busca de teste da tela vão em `knowledge_usage`. O embedding da pergunta
    durante a ligação soma no extrato da própria ligação (`usage_ledger`), para o custo por minuto já
    incluí-lo.

11. **Uso na ligação** (medido ponta a ponta com a sessão real do motor, transcrição e síntese simuladas, base de 32 mil
    tokens com embeddings reais, 40 perguntas): no modo de busca, a cada fala de quem ligou saem **juntas** a busca por palavras
    (10 a 12 ms no banco) e o embedding da pergunta (479 ms de mediana). A busca é **especulativa**: dispara no texto parcial da
    transcrição (3 palavras ou mais, parado 120 ms, no máximo 8 por turno), e no fim do turno reaproveita o resultado se o texto
    final tem ao menos 80% das palavras do parcial. O turno espera no máximo **100 ms** pela busca; passou disso, segue só com as
    palavras (ou sem trechos), e o motivo vai para a linha do tempo. Resultado: espera de 0 a 13 ms na mediana e ~100 ms no p90; o
    vetor chegou a tempo em 78 a 83% dos turnos.
12. **Onde os trechos entram.** Os trechos do turno (até ~1.500 tokens, com fonte e seção) vão numa mensagem de sistema logo antes
    da última fala, fora do prefixo e sem ficar no histórico: o prefixo fixo continua idêntico entre turnos e entre ligações do
    agente, e o cache de prompt do Haiku acerta (10.705 de 10.776 tokens lidos do cache com os trechos no meio). No modo de base
    inteira, os documentos entram numa seção fixa do prompt de sistema, em ordem determinística.
13. **O classificador barato ("Jev") não entra.** Medido contra 40 perguntas e 10 falas curtas: custa de 20 a 100 vezes o embedding
    (US$ 1,2e-5 a 7,3e-5 contra 6,5e-7 por pergunta), soma 280 a 675 ms de latência e deixaria sem a base de 2 a 7 de 40 perguntas
    que precisavam dela. A heurística local (`needsKnowledge`: só confirmação, saudação, despedida, hesitação ou número não
    busca) errou 0 de 40 e pegou as 10 falas curtas, sem custo.
14. **Auditoria.** O evento `llm_call` ganha o bloco `knowledge` (modo, trechos com id, fonte, posição, seção e pontuação, espera,
    se foi especulativa, se usou o vetor, tokens de embedding e o motivo do fallback), sem texto da conversa nem dos trechos; o evento
    `knowledge_loaded` registra o carregamento no começo da ligação. O custo do embedding da pergunta soma ao extrato da ligação.
15. **Perfis D e E fixam o provedor.** A medição achou que o motor mandava `model` e, por isso, deixava de mandar a ordem de provedores:
    os perfis D (Cerebras) e E (Together) respondiam por qualquer provedor, com primeiro token de até 11 s. Corrigido no mesmo lançamento.

### Números da medição (resumo)

| Configuração | Acerto (n = 36) | Busca + modelo p50 | Dentro de 0,5 s | US$ por turno |
|---|---|---|---|---|
| Busca · Haiku 5.5 (B) | 35 | 606 ms | 0 de 40 | 0,00043 |
| Busca · DeepSeek V4.1 Flash, Together (E) | 33 | 285 ms | 36 de 40 | 0,00049 |
| Busca · gpt-oss-120b, Cerebras (D) | 32 | 479 ms | 24 de 40 | 0,00099 |
| Base inteira · Haiku 5.5 (B) | 33 | 674 ms | 0 de 40 | 0,00065 |
| Base inteira · DeepSeek (E) | 33 | 370 ms | 32 de 40 | 0,00026 |
| Base inteira · gpt-oss-120b (D) | 34 | 767 ms | 0 de 40 | 0,01003 |

Diferença de 1 a 3 perguntas em 36 é ruído. A meta de 0,5 s (busca mais modelo) só o perfil E fecha; o Haiku fica em 0,57 a 0,67 s de
modelo em qualquer modo. A base inteira não acerta mais que a busca com 32 mil tokens, e custa até 10 vezes mais no perfil D, o que
sustenta o limite de 6.000 tokens do modo automático.

## Limitações conhecidas

- **Fora da base**: com "responder só pela base", 1 a 4 de 4 perguntas fora da base foram tratadas certo conforme o perfil, e o DeepSeek
  chegou a inventar um preço. A instrução ajuda e não elimina; antes de prometer isso a um operador, vale uma rodada de ajuste do texto.
- Perguntas que exigem juntar duas seções ("tenho esse convênio e a limpeza, tem carência?") falham em boa parte das configurações,
  inclusive com a base inteira.
- O primeiro turno frio do Haiku com a base inteira (46 mil tokens) leva 1,25 s e custa US$ 0,0058 (escrita do cache); depois, 0,5 a 0,9 s
  e US$ 0,0005. Aquecer o cache no começo da ligação ficou de fora.
- Nada foi medido com áudio e Deepgram reais: a transcrição e a síntese da medição são simuladas.

- Sem OCR: um PDF só de imagem falha com `scanned_pdf`.
- A busca por palavras usa o dicionário `portuguese`; base em inglês ou espanhol depende mais da busca por
  similaridade.
- Tabelas de PDF chegam como texto corrido, na ordem em que o leitor as extrai.
- A latência do embedding da pergunta (~450 ms) é do provedor. O uso na ligação (busca especulativa e
  orçamento de latência) está em `docs/guides/base-de-conhecimento.md`.

## Ordem do deploy (obrigatória)

1. Backup do banco de produção (`pg_dump`, conferido com `pg_restore --list`).
2. Aplicar a migration `20261125T170000_base_de_conhecimento.sql` à mão, com `MIGRATION_DATABASE_URL`
   (o dono do schema), **antes** do merge. O deploy do Coolify não aplica migrations.
3. Merge e redeploy. A migration é só aditiva: as tabelas novas e duas colunas de `agents` com padrão.

## Como reverter

O código novo ignora a base quando o agente não tem nenhuma. Para desfazer o schema: migration nova que
apaga as tabelas `knowledge_*` e `agent_knowledge_sources` e as colunas `agents.knowledge_mode` e
`agents.knowledge_only` (depois de reverter o deploy). A extensão `vector` pode ficar.
