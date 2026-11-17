---
impact: new_capability
section: added
title: A plataforma troca o plano de uma empresa pelo detalhe, e o plano passa a ter uma fonte só
---

No detalhe de uma empresa, dono ou administrador da organização que administra a instalação troca o plano: do catálogo, ou Personalizado com mensalidade, franquia, chamadas simultâneas, regra e preço do excedente. A troca pede confirmação nomeando a empresa e o plano, mantém o ciclo onde estava e fica no histórico das duas organizações. O plano contratado passa a ser lido só de `plan_subscriptions`: as colunas `plan_code` e `monthly_minutes` do perfil da empresa deixam de ser lidas e gravadas (a migration só as marca como obsoletas, sem apagar nada). Quem provisionou uma empresa pela API com um código fora do catálogo passa a vê-la como "sem plano", como ela já era tratada na medição; o código pedido continua no evento de criação. Nada a configurar em instalações existentes. Crédito: @DeskLabs-OpenSource/maintainers.
