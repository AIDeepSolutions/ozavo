# Cobrança nativa pelo Asaas

Decisão do dono de 16/11/2026: o Ozavo usa sua stack própria e integra o Asaas diretamente.
A rota pública é `POST /api/v1/webhooks/asaas`. O provisionamento por API e os webhooks universais
continuam disponíveis para sistemas externos. Não existe dependência interna de n8n.

## Configurar pela tela

1. Entre como dono ou administrador da **organização da plataforma**, que administra a instalação.
2. Abra **Configurações → Integrações → Asaas**. Escolha **Sandbox** para homologar.
3. Informe a chave da API dessa conta Asaas e um token de webhook aleatório com pelo menos 32
   caracteres. Os dois ficam cifrados com a chave da instalação; a API nunca os devolve.
4. Na conta Asaas do mesmo ambiente, cadastre um webhook com a URL exibida na tela:
   `https://seu-painel.example/api/v1/webhooks/asaas`. Configure o mesmo token de autenticação;
   o Asaas o envia no cabeçalho `asaas-access-token`.
5. Habilite `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`,
   `PAYMENT_CHARGEBACK_REQUESTED`, `SUBSCRIPTION_CREATED`, `SUBSCRIPTION_UPDATED`,
   `SUBSCRIPTION_INACTIVATED` e `SUBSCRIPTION_DELETED`. Prefira entrega sequencial.
6. A assinatura precisa ser mensal (`MONTHLY`), com cliente que tenha nome e e-mail válido.
   Sem vínculo explícito, o **valor da assinatura**, nunca o valor líquido do pagamento,
   escolhe o plano: R$ 497 Starter/300 min, R$ 997 Pro/750 min, R$ 1.497 Growth/1.500 min,
   R$ 1.997 Scale/2.500 min. Os tetos simultâneos vêm do catálogo da Fase 3.
7. Para descontos, preços negociados ou Personalizado, cadastre o vínculo explícito pelo id da
   assinatura. Personalizado exige franquia e teto simultâneo; o preço vem da assinatura.
8. Homologue o ciclo inteiro e então configure **Produção** com chave e token próprios. Trocar
   ambiente exige informar os dois segredos novamente. Eventos e vínculos têm ambiente próprio:
   um evento de sandbox nunca é aplicado com credenciais de produção.

Nenhuma variável de ambiente nova nem arquivo na VPS é necessário. Nenhuma chave real deve ir para
Git, exemplo, teste ou log. A integração só consulta assinatura e cliente; não cria cobranças,
contratos ou assinaturas no Asaas e não guarda cartão, CPF/CNPJ ou o corpo bruto do webhook.

## Empresa, convite e plano

`SUBSCRIPTION_CREATED` cria a empresa com plano e convite, **suspensa até o pagamento**.
`PAYMENT_CONFIRMED` ou `PAYMENT_RECEIVED` também pode criar a empresa quando chegar primeiro.
O provisionamento reaproveita `provisionTenant` e `setPlanSubscription`: organização, perfil,
agente, plano, franquia, política de saída desligada e convite de dono são gravados na mesma
transação que o recibo processado. O agente inicial é simulado e não tem credenciais de voz:
o dono configura o motor e a linha antes de operar chamadas reais.

Em **Convites de donos**, a plataforma abre o `ownerInviteUrl` e o encaminha ao dono por um canal
apropriado. O link é segredo de acesso de uso único, vale sete dias e desaparece da consulta após
aceitação ou expiração. O token fica cifrado no vínculo; a tabela de convites guarda apenas seu
resumo. Reenvios de cobrança não rotacionam o convite. Não há envio automático de e-mail.
Convite expirado pode ser renovado pela API de provisionamento, com a mesma referência externa;
a resposta dessa API é o novo link. A tela do Asaas não renova links expirados.

Em produção, vínculos antigos da Fase 2 com `source=asaas` e `externalRef=sub_…` são adotados,
sem criar outra empresa. Novos vínculos usam `production:sub_…` ou `sandbox:sub_…`. Antes de
renovar pela API, confira qual dessas referências está gravada na empresa.

Uma confirmação/recebimento por pagamento quita a pendência correspondente. `PAYMENT_OVERDUE`
suspende; um pagamento antigo não quita a dívida de outro. Atraso reenviado depois de quitação do
mesmo pagamento é ignorado. Estorno/chargeback suspende e não é revertido por confirmação antiga.
Inativação suspende; exclusão cancela de forma terminal, sem apagar empresa nem histórico. A empresa
cancelada fica suspensa, com `cancelled=true` no vínculo. Exclusão recebida antes da criação deixa
um marcador que impede o provisionamento por um evento antigo. Empresa suspensa não usa chave de
API nem inicia ligação de saída; a sessão de áudio também recusa antes de conectar um motor pago,
registra `call_refused` e envia o sinal de falha. Chamadas já em curso não são interrompidas.

Atualização de assinatura troca plano/franquia sem zerar o ciclo nem quitar dívida. Eventos de
organização `tenant_provisioned`, `plan_changed` e `asaas_subscription_changed` registram a história;
`asaas_config_changed` registra mudanças de configuração. Não se inventa chamada para registrar
cobrança: `call_events` recebe as recusas de chamadas reais afetadas pela suspensão.

## Entrega e recuperação

O receptor autentica por comparação em tempo constante dos resumos do token, valida o envelope e
remove campos não utilizados. Só responde HTTP 200 depois de confirmar **evento + tarefa** no
Postgres. Evento repetido no mesmo ambiente devolve `repeated: true`, sem criar nova tarefa.
Sem token válido: 401; corpo inválido: 400; corpo acima de 256 KB: 413; falha de persistência: 503
para o Asaas reenviar. Eventos desconhecidos ou cobranças avulsas sem assinatura são reconhecidos
e encerrados sem alterar empresa. Assinaturas não mensais e valores sem mapeamento ficam pendentes.

`process_asaas_event` é descoberta pela pasta de rotinas e usa a fila por notificação existente.
O consumidor tenta três vezes com recuo. Falha mantém o recibo sem `processed_at`; após esgotar as
tentativas ele continua na caixa de entrada, mesmo que a tarefa fique `failed`. Corrija chave,
cliente, plano ou indisponibilidade e use **Reprocessar eventos pendentes** na mesma tela. Esse
botão só reenfileira os que não têm tarefa pendente/em execução. A tela lista os últimos 50 recibos.
A fila guarda mensagem genérica de falha; não copia resposta de provedor, e-mail nem payload de SQL.

Sandbox pendente com ambiente atual em produção não é descartado: restaure as credenciais de
sandbox e reprocesse. Corrija pendências antes de mudar o ambiente. Não há varredura periódica,
provisionamento retroativo ou conciliação automática com o histórico anterior à integração.
Pagamentos estornados/chargebacks exigem análise da plataforma; não há ação nesta entrega para
liberar esse bloqueio depois da análise. É uma limitação operacional pendente, e reenviar um
pagamento antigo ou apertar Reprocessar não o libera. Cliente sem e-mail ou e-mail já usado na instalação permanece pendente para correção.

## Migration e validação

Migration aditiva: `db/migrations/20261116T230000_asaas_nativo.sql`. Cria `asaas_events`,
`asaas_subscriptions` e `asaas_payments`, com organização e RLS. O executor normal aplica na
atualização; não se deve aplicar manualmente no Supabase. Nenhuma migration publicada foi editada.

Os testes usam API falsa e Postgres descartável. Rodar `pnpm verify` e `pnpm test:db` antes do PR.

## Fontes conferidas em 16/11/2026

- [Receber eventos e autenticar o webhook](https://docs.asaas.com/docs/receba-eventos-do-asaas-no-seu-endpoint-de-webhook).
- [Idempotência por id do evento](https://docs.asaas.com/docs/como-implementar-idempotencia-em-webhooks).
- [Eventos de cobrança](https://docs.asaas.com/docs/webhook-para-cobrancas).
- [Eventos de assinatura](https://docs.asaas.com/docs/eventos-para-assinaturas).
- [Consultar assinatura](https://docs.asaas.com/reference/recuperar-uma-unica-assinatura).
- [Consultar cliente](https://docs.asaas.com/reference/recuperar-um-unico-cliente).

Os preços/franquias acima são do catálogo do **Ozavo**, não tarifas do Asaas.
