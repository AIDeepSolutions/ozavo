---
impact: operator_action
section: added
title: Cada agente em pipeline liga ou desliga a frase de ponte e o pedido adiantado ao modelo
---

Em Agentes, no motor Deepgram + OpenRouter + Cartesia, duas chaves novas, ligadas por padrão: "Frase curta enquanto o modelo pensa" (o agente diz "Certo." ou "Um instante." com a voz dele quando o modelo demora, e nunca antes de uma confirmação de agenda) e "Adiantar o pedido ao modelo" (o pedido sai um instante antes de o fim do turno ser confirmado e é descartado se a pessoa continuar). Crédito: @AIDeepSolutions.

## Requer atenção

Aplique a migration `20261125T190000_agents_latency_toggles.sql` **antes** de atualizar o código: o Coolify não aplica migrations, e sem as colunas `agents.latency_bridge` e `agents.latency_speculation` a API de agentes e as ligações falham (passo a passo em `docs/guides/producao-coolify.md`). Os agentes existentes ficam com as duas chaves ligadas.
