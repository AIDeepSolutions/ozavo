---
impact: operator_action
section: fixed
title: O teto de chamadas da conta de síntese de voz vale para a instalação inteira e conta também as ligações recebidas
---

O número de chamadas simultâneas da conta na Cartesia era informado por empresa e contado só pelas ligações de saída do processo de voz, então uma empresa sem o número preenchido, ou uma ligação recebida, podia passar do limite do provedor e deixar a chamada muda. Agora o valor informado pela organização que administra a instalação, em FinOps → Limites de operação, vale para todas as empresas, conta as ligações recebidas e de saída de todas elas, e duas ligações ao mesmo tempo não furam a última vaga. Acima do teto, a ligação de saída é recusada e a recebida ouve sinal de ocupado, com o motivo na linha do tempo e um aviso no painel. Crédito: @AIDeepSolutions.

## Requer atenção

Se o teto da conta de síntese estava informado em cada empresa, informe-o uma vez em FinOps → Limites de operação, entrando pela organização que administra a instalação. Sem esse valor, a instalação continua sem teto pelo provedor.
