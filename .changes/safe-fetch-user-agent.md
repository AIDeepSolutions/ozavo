---
impact: new_capability
section: fixed
title: A agenda do Cal.com volta a funcionar no servidor: as chamadas de saída se identificam com User-Agent
---

Em produção, a consulta de horários do Cal.com recebia 403 da Cloudflare ("Just a moment...") porque a chamada de saída não mandava User-Agent; no servidor de produção isso bastou para o pedido ser tratado como robô, e o agente dizia que a agenda não respondia. Toda chamada de saída das ferramentas (agenda, webhook, WhatsApp) agora manda `User-Agent: Ozavo/1.0`, salvo quando quem chama define o seu. Quem já instalou não precisa fazer nada. Crédito: @AIDeepSolutions.
