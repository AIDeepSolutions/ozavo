---
impact: operator_action
section: added
title: Webhooks de saída e de entrada por empresa
---

Cada empresa cadastra, em Configurações → Integrações, destinos https que recebem fim de chamada, desfecho, alerta de franquia e redução de cadência, em JSON assinado com HMAC-SHA256 no cabeçalho X-Ozavo-Signature, com recuo entre tentativas e o resultado de cada entrega na tela. O segredo aparece uma única vez, e trocá-lo ou remover um destino pede confirmação. Sistemas de fora também podem pedir uma ligação por requisição em POST /api/v1/hooks/call, com uma chave de API do novo escopo hooks:inbound, pela mesma política de ligações de saída. Crédito: @AIDeepSolutions.

## Requer atenção

Esta versão traz a migration 20261117T201000_webhook_subscriptions.sql (tabela webhook_subscriptions e o escopo hooks:inbound nas chaves de API). Aplique-a com o comando de migrations da instalação, como nas versões anteriores, antes de usar a tela de webhooks; sem ela, a tela devolve erro, mas as chamadas e os alertas continuam funcionando.
