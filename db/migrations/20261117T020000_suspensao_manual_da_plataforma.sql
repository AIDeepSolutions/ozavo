-- A suspensão decidida pela plataforma vence a cobrança.
--
-- Quando a organização que administra a instalação suspende uma empresa pela tela, a empresa fica
-- suspensa até a plataforma reativar, mesmo que o Asaas confirme um pagamento depois. Sem esta
-- coluna, o próximo evento do Asaas recalculava a situação e reativava a empresa sozinho.
-- Padrão falso: nenhuma empresa existente muda de situação.
alter table tenant_profiles add column suspended_by_platform boolean not null default false;
