---
impact: new_capability
section: added
title: Alertas críticos das empresas chegam à organização que administra a instalação
---

Quando uma empresa cliente chega a 80% ou 100% da franquia, ou quando o disjuntor de chamadas curtas reduz a cadência dela, a organização que administra a instalação também recebe o aviso no painel, com o nome da empresa e os números de consumo, e o evento `tenant_critical_alert` no histórico. O aviso sai uma vez por alerta, pela fila, na mesma transação em que a empresa grava o dela. Nenhum dado de quem ligou vai junto. Nada a configurar em instalações existentes. Crédito: @DeskLabs-OpenSource/maintainers.
