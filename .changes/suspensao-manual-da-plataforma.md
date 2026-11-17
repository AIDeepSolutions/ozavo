---
impact: new_capability
section: changed
title: Suspensão feita pela plataforma vale até a plataforma reativar
---

Quando a organização que administra a instalação suspende uma empresa pela tela de Empresas, a empresa fica suspensa até alguém da plataforma reativá-la, mesmo que o Asaas confirme um pagamento depois. Antes, o próximo evento do Asaas recalculava a situação e podia reativá-la sozinho. O detalhe da empresa avisa quando a suspensão é da plataforma, e o evento do Asaas registra que a trava segurou. A situação inicial "suspensa até o pagamento" de uma empresa nova não trava: o pagamento confirmado reativa, como antes. A migration acrescenta uma coluna com padrão falso: nenhuma empresa existente muda de situação. Nada a configurar. Crédito: @DeskLabs-OpenSource/maintainers.
