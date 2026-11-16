---
impact: operator_action
section: changed
title: O provisionamento pela API entrega um convite ao dono em vez da senha, e o FinOps mede a fala da IA e mostra todas as empresas à plataforma
---

O provisionamento de empresas pela API deixa de devolver a senha inicial do dono: a resposta traz um link de convite de uso único, válido por 7 dias, em que o dono escolhe a própria senha. A tela FinOps mostra quanto do tempo das ligações foi fala da IA, com a meta de ficar abaixo de 50%, e a organização que administra a instalação passa a ver o consumo de todas as empresas do mês. Também mudam, sem nada a fazer: o plano com franquia zero e regra de pausar deixa as ligações de saída pausadas; a linha TLS cadastrada com a porta 5060 passa a usar a 5061, e o PAI leva o domínio da operadora; a manutenção diária das gravações só consulta o S3 para o que ainda falta copiar ou apagar; e só o papel de sistema do banco muda a marca de organização da plataforma. Crédito: @AIDeepSolutions.

## Requer atenção

Quem chama `POST /api/v1/tenants/provision` (por exemplo, um fluxo do n8n) precisa trocar o campo `initialPassword` por `ownerInviteUrl` e enviar esse link ao dono da empresa. A atualização aplica três migrations aditivas.
