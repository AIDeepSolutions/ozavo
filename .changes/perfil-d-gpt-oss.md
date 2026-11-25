---
impact: operator_action
section: added
title: Dois perfis "Rápido (experimental)" de modelo de texto (gpt-oss-120b e DeepSeek V4.1 Flash)
---

Em Agentes, o campo "Modelo de texto" ganha a opção "Rápido (experimental): gpt-oss-120b", que usa raciocínio baixo e roteia por Cerebras, Groq e BaseTen. Na bancada de 25/11/2026 o primeiro trecho de resposta saiu em cerca de 0,4 segundo, contra cerca de 0,7 do Haiku, com mais erros de ferramenta e português menos natural. Serve para testar ao vivo lado a lado com o perfil de Telefonia. Crédito: @AIDeepSolutions.

## Requer atenção

Aplique a migration `20261125T150000_agents_llm_profile_d_e.sql` **antes** de atualizar o código: o Coolify não aplica migrations, e sem ela a API recusa salvar um agente com o perfil novo. Ninguém muda de perfil sozinho: o padrão continua o Qualidade primeiro.
