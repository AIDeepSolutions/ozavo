-- O plano de uma organização tem uma fonte só: `plan_subscriptions`.
--
-- `tenant_profiles.plan_code` e `tenant_profiles.monthly_minutes` eram uma segunda cópia, gravada
-- pelo provisionamento e pelo Asaas, que podia divergir do plano contratado. A partir desta versão
-- o código não lê nem grava mais essas colunas. Elas ficam no banco, só como registro do que já foi
-- gravado: apagá-las é uma migration futura, anunciada nas notas de versão. O código e os minutos
-- pedidos no provisionamento continuam no evento `tenant_provisioned`.
comment on column tenant_profiles.plan_code is 'Obsoleta desde 2026-11-17: o plano mora em plan_subscriptions. Não é lida nem gravada.';
comment on column tenant_profiles.monthly_minutes is 'Obsoleta desde 2026-11-17: a franquia mora em plan_subscriptions. Não é lida nem gravada.';
