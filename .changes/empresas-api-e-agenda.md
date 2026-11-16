---
impact: new_capability
section: added
title: Empresas provisionadas pela API, chaves de API, disparo de ligação por sistema de fora e agenda Cal.com ou Google
---

Cada empresa ganha um perfil em Configurações > Empresa e API: razão social, CNPJ conferido, nome da persona, voz padrão e uma instrução base que vem antes da instrução de cada agente. Na mesma tela, o dono cria e revoga chaves de API. Com uma chave de escopo `calls:outbound`, um sistema como o n8n pede uma ligação por `POST /api/v1/calls/outbound`, com contexto do lead e chave de repetição; a ligação vai direto ao processo de voz e passa pelas mesmas regras de ligação de saída, que continuam nascendo desligadas. A organização que administra a instalação (a primeira criada) pode emitir chave `tenants:provision` e criar empresas por `POST /api/v1/tenants/provision`, com plano, dono e agente prontos. Em Integrações, a agenda das ferramentas de agenda passa a ser a da empresa: Cal.com por chave de API ou Google Agenda por autorização OAuth; sem agenda, as ferramentas não são oferecidas na ligação. Nada a fazer em instalações existentes: as migrations entram na atualização e nada muda até alguém configurar. Crédito: @AIDeepSolutions.
