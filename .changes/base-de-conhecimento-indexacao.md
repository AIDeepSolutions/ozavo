---
impact: operator_action
section: added
title: Base de conhecimento do agente de voz (indexação de documentos)
---

A empresa passa a poder indexar documentos (PDF, DOCX, Markdown, texto e texto colado) para o agente consultar na ligação: uma rotina em segundo plano extrai o texto, parte em trechos, gera os embeddings pelo OpenRouter com a chave do motor em pipeline e grava tudo no banco, com custo registrado e teto de 5 milhões de tokens por empresa. Esta parte traz o banco e a rotina; as telas e o uso na ligação vêm nos próximos lançamentos. Crédito: @AIDeepSolutions.

## Requer atenção

Esta versão traz a migration 20261125T170000_base_de_conhecimento.sql, que liga a extensão pgvector. No Supabase ela já é oferecida e a migration a liga sozinha. Quem instala pelo Compose recebe, ao atualizar, a imagem do Postgres com pgvector (Debian no lugar de Alpine); o atualizador sobe o banco com ela antes das migrations. Depois da primeira atualização, rode uma vez `docker compose exec postgres psql -U ozavo -d ozavo -c 'reindex database ozavo'` para reconstruir os índices de texto na ordenação nova; sem isso, uma busca por texto pode não achar uma linha que existe. Instalação nova não precisa.
