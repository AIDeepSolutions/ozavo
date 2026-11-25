# Base de conhecimento do agente

Para quem opera o Ozavo: como a base funciona, o que custa e como conferir. A decisão e os números estão em
[`0022-base-de-conhecimento.md`](../decisions/0022-base-de-conhecimento.md).

## O que entra e quanto pode

| Item | Teto |
|---|---|
| Tipos de arquivo | PDF (com texto), DOCX, Markdown, TXT e texto colado |
| Tamanho do arquivo | 20 MB |
| Uma fonte | 1 milhão de tokens (~1.500 páginas) |
| A empresa inteira | 5 milhões de tokens e 200 fontes |

PDF digitalizado (só imagem) não tem texto: a indexação falha com o motivo "PDF sem texto". Ainda não há OCR.

## Quanto custa indexar

O embedding custa US$ 0,02 por milhão de tokens (OpenRouter, `openai/text-embedding-3-small`).

| Documento | Tokens | Custo |
|---|---|---|
| 1 página | ~850 | US$ 0,000017 |
| 40 páginas | ~32.000 | US$ 0,00064 |
| 1 MB de texto | ~250.000 | US$ 0,005 |
| O teto da empresa | 5.000.000 | US$ 0,10 |

Reindexar custa o mesmo de novo. A busca de cada pergunta custa ~US$ 0,0000003.

## Como o agente usa

Cada agente escolhe as bases e o modo: automático, busca por pergunta ou base inteira no prompt. Veja a seção
de uso na ligação neste guia depois da integração com a voz.

## Atualizar uma instalação pelo Compose

A imagem do Postgres passa a ser a do pgvector (Debian). Depois da primeira atualização, uma vez:

```bash
docker compose exec postgres psql -U ozavo -d ozavo -c 'reindex database ozavo'
```
