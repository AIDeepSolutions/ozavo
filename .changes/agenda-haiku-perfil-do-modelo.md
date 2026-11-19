---
impact: operator_action
section: changed
title: O agente de voz em pipeline passa a usar o Claude Haiku 5.5, com perfil do modelo escolhido por agente
---

O motor Deepgram + OpenRouter + Cartesia usa o Claude Haiku 5.5 como padrão, com cache do prompt, e cada agente ganha o campo "Modelo de texto" na tela (Qualidade primeiro, Telefonia com resposta mais rápida, ou o Gemini 2.5 Flash de antes). A linha do tempo da chamada mostra, a cada chamada ao modelo, o provedor, o motivo do fim da resposta e os tokens de raciocínio e de cache. A agenda também ganha a trava de autorização das escritas: só marca, remarca ou cancela depois de um sim claro e da leitura do horário, e só mexe no compromisso criado na própria ligação ou informado no pedido da ligação de saída em `context.appointmentIds`. Crédito: @AIDeepSolutions.

## Requer atenção

Aplique a migration `20261119T120000_agents_llm_profile.sql` **antes** de atualizar o código: o Coolify não aplica migrations, e sem a coluna `agents.llm_profile` a API de agentes e as ligações falham (passo a passo em `docs/guides/producao-coolify.md`). Agentes que já usam o pipeline passam ao Haiku ao atualizar; para manter o Gemini 2.5 Flash, escolha "Gemini 2.5 Flash (o de antes)" em Modelo de texto, em Agentes. Numa ligação recebida, o agente não remarca nem cancela um compromisso antigo por conta própria: ele oferece anotar o pedido ou passar a uma pessoa.
