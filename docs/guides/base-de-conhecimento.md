# Base de conhecimento do agente

Para quem opera o Ozavo: como a base funciona, o que custa e como conferir. A decisão e os números medidos estão em
[`0022-base-de-conhecimento.md`](../decisions/0022-base-de-conhecimento.md).

## Como usar

1. **Painel › Base de conhecimento › Adicionar uma base.** Arraste um PDF, DOCX, Markdown ou TXT (até 20 MB) ou use "Colar texto".
   A indexação roda em segundo plano: a base aparece "na fila", depois "indexando" e, quando "pronta", já responde.
2. **Painel › Agentes › (o agente) › Base de conhecimento.** Marque as bases que ele usa (várias; uma base serve a vários agentes),
   escolha o modo e salve.
3. **Teste.** Na própria tela da base, "Testar a busca" mostra os trechos que o agente acharia para uma pergunta. Depois, "Falar com o
   agente" (Chamadas) e pergunte algo que só a base sabe.

A chave do OpenRouter é a mesma do motor em pipeline (Configurações › motor de voz): não há segredo novo. Sem ela, a indexação falha
com o motivo "sem chave".

### Os três modos

| Modo | O que faz | Quando |
|---|---|---|
| Automático | Base inteira no prompt se as bases do agente somam até 6.000 tokens; acima disso, busca por pergunta | Padrão |
| Busca por pergunta (RAG) | A cada fala, busca os 4 trechos mais próximos e os manda ao modelo | Bases médias e grandes |
| Base inteira no prompt | Todo o texto das bases vai junto das instruções, com cache de prompt | Bases pequenas |

"Responder só com o que está na base" manda o agente dizer que não tem a informação (e oferecer recado ou transferência) em vez de
completar de cabeça. Ajuda, mas não elimina: em 4 perguntas de fora da base, o modelo mais barato ainda inventou um valor uma vez.

## O que entra e quanto pode

| Item | Teto |
|---|---|
| Tipos de arquivo | PDF (com texto), DOCX, Markdown, TXT e texto colado |
| Tamanho do arquivo | 20 MB |
| Uma fonte | 1 milhão de tokens (~1.500 páginas) |
| A empresa inteira | 5 milhões de tokens e 200 fontes |

PDF digitalizado (só imagem) não tem texto: a indexação falha com o motivo "PDF sem texto". Ainda não há OCR.

## Teto de gasto

Medido em 25/11/2026 (preços do OpenRouter na data: embedding US$ 0,02 por milhão de tokens). Valores em dólar.

### Indexar (uma vez por versão; reindexar custa de novo)

| Unidade | Tokens | Custo |
|---|---|---|
| 1 página de texto (~850 tokens) | 850 | US$ 0,000017 |
| 1 MB de texto puro (~250 mil tokens) | 250.000 | US$ 0,005 |
| 1 MB de PDF (varia com o conteúdo; o PDF de teste de 330 KB tinha 32,8 mil tokens) | ~100.000 | US$ 0,002 |
| 1 milhão de tokens | 1.000.000 | US$ 0,02 |
| Manual de 37 páginas (medido: 32.774 tokens, 117 trechos, 3,2 s de indexação) | 32.774 | **US$ 0,00067** |
| O teto da empresa | 5.000.000 | US$ 0,10 |

### Por ligação de 2 minutos (~10 falas de quem liga, base de 32 mil tokens, modelo e embedding)

Custo por fala medido na bancada (cache de prompt quente; modelo + embedding da pergunta), multiplicado por 10.

| Modo e modelo | Por fala | Por ligação de 2 min |
|---|---|---|
| Busca · DeepSeek V4.1 Flash (perfil E) | US$ 0,00049 | **US$ 0,0049** |
| Busca · Haiku 5.5 (perfil B) | US$ 0,00043 | **US$ 0,0043** |
| Busca · gpt-oss-120b (perfil D) | US$ 0,00099 | **US$ 0,0099** |
| Base inteira · DeepSeek (E) | US$ 0,00026 | US$ 0,0026 |
| Base inteira · Haiku (B) | US$ 0,00065 | US$ 0,0065 |
| Base inteira · gpt-oss (D) | US$ 0,01003 | **US$ 0,10** |

- O embedding da pergunta custa ~US$ 0,00000065 por fala (a busca especulativa pede ~4 embeddings de ~8 tokens por pergunta); soma ao
  extrato da própria ligação e já está nos valores acima.
- O primeiro turno frio do Haiku com a base inteira de 32 mil tokens custa US$ 0,0058 (escrita do cache) e vale por ~5 minutos.
- Busca de teste na tela: ~US$ 0,0000003 cada; entra em "Custos › FinOps › Base de conhecimento (embeddings)" junto da indexação.
- O teto de custo por ligação de cada agente (`cost_ceiling_cents`) continua valendo.

Em resumo: indexar custa centavos de dólar por **milhares** de páginas; o custo que importa é o do modelo por ligação, e a busca por
pergunta é mais barata que a base inteira no Haiku (US$ 0,00043 contra 0,00065) e muito mais no gpt-oss (0,00099 contra 0,01003); só no DeepSeek a base inteira é mais barata (0,00026 contra 0,00049), porque o cache lê quase todo o prompt.

## Latência

- A busca por palavras sai na hora (10 a 12 ms no banco); o embedding da pergunta leva ~480 ms no OpenRouter e por isso a busca é
  **especulativa**: começa no texto parcial da transcrição, enquanto a pessoa ainda fala.
- O turno espera no máximo 100 ms pela busca: a espera medida foi de 0 a 13 ms na mediana e ~100 ms no p90.
- Com o perfil E (DeepSeek, Together), busca mais modelo fica em 285 ms de mediana, dentro de 0,5 s em 36 de 40 falas. O Haiku fica em
  0,57 a 0,67 s só de modelo.

## Onde olhar quando algo parece errado

- **Fonte "falhou"**: o motivo aparece na linha dela (arquivo ilegível, PDF só de imagem, teto, sem chave, chave recusada, provedor fora
  do ar). "Reindexar" tenta de novo com o texto já extraído; se o arquivo estava errado, "Substituir".
- **Ligação**: na linha do tempo, o evento do modelo lista os trechos citados (fonte, seção e pontuação, nunca o texto) e a espera
  pela busca; `knowledge_loaded` mostra como a base foi carregada. Se a busca falhou ou atrasou, o motivo está lá e o agente respondeu
  sem a base.

## Importar de outro sistema

```bash
pnpm --filter @ozavo/routines run import-knowledge -- --org <id da empresa> --name "Nome da base" \
  --file caminho/arquivo.pdf --agent <id do agente> --agent <outro agente>
```

Rodar de novo com o mesmo nome troca o conteúdo (versão nova) em vez de duplicar. As fontes de exemplo da AI Deep Solutions estão em
`design/knowledge/ads/`.

## Atualizar uma instalação pelo Compose

A imagem do Postgres passa a ser a do pgvector (Debian). Depois da primeira atualização, uma vez:

```bash
docker compose exec postgres psql -U ozavo -d ozavo -c 'reindex database ozavo'
```
