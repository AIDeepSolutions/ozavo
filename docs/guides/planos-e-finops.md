# Planos, franquia, cadência e FinOps

Este guia descreve o que a Fase 3 colocou no produto: o plano contratado por organização, a
medição da franquia em tempo real, o limite de chamadas ao mesmo tempo, a redução de cadência por
excesso de chamadas curtas, o limite de caracteres por turno e a tela de FinOps. Tudo se configura
pela tela **FinOps** do painel; nada se liga por variável de ambiente.

Organização sem plano continua exatamente como antes: nada é limitado nem alertado.

## Plano contratado

O catálogo mora no código (`PLAN_CATALOG`, em `packages/core/src/plans.ts`), e cada organização
guarda em `plan_subscriptions` a cópia dos valores em vigor.

| Plano | Mensalidade | Franquia | Chamadas ao mesmo tempo |
|---|---|---|---|
| Starter | R$ 497,00 | 300 min | 2 |
| Pro | R$ 997,00 | 750 min | 3 |
| Growth | R$ 1.497,00 | 1.500 min | 4 |
| Scale | R$ 1.997,00 | 2.500 min | 8 |
| Personalizado | informada | informada | informada |

Preço e franquia vêm da especificação comercial recebida em 2026-11-16. O número de chamadas ao
mesmo tempo **não** está na especificação: é o padrão desta versão (veja "Decisões em aberto").

O único caminho que grava o plano é `setPlanSubscription`. A tela chama por
`PUT /api/v1/finops/plan`, e só a organização que administra a instalação (`organizations.platform`)
grava: dono ou administrador de uma empresa cliente lê o plano e os limites de operação, mas recebe
403 `platform_only` ao tentar trocá-los. Sem isso, a própria empresa escolheria o Personalizado com
franquia ilimitada ou afrouxaria a cadência reduzida. O provisionamento por API (`POST /api/v1/tenants/provision`) chama a
mesma função quando o `plan.code` é do catálogo (`starter`, `pro`, `growth`, `scale`): a empresa já
nasce com a franquia, na regra de pausar as ligações de saída. Um código fora do catálogo fica só
como vínculo no perfil da empresa, e ela segue sem plano. Ainda não existe tela da plataforma para
trocar o plano de outra empresa: hoje isso se faz pelo provisionamento. Cada troca
grava o evento de organização `plan_changed`.

O ciclo é mensal e começa no dia de `cycle_started_on`. Quem começou no dia 31 renova no último dia
dos meses mais curtos.

## Franquia e alertas

O consumo é a duração das ligações atendidas no ciclo, do atendimento ao fim; a que está em curso
conta até agora. A chamada simulada pelo painel não consome.

- A cada medição da chamada (no máximo uma vez a cada 30 segundos) e a cada tentativa de ligação de
  saída, `checkUsageAlerts` confere a franquia.
- Ao cruzar **80%** e **100%**, sai um aviso no painel e o evento `plan_usage_alert`. Um aviso por
  limiar e por ciclo (`usage_alerts`).
- Com a franquia esgotada, vale a regra de excedente da organização:
  - `pause_outbound`: as ligações de saída são recusadas com `plan_quota_exhausted` até o próximo
    ciclo;
  - `bill_overage`: as ligações continuam, e os minutos além da franquia entram como receita de
    excedente, pelo preço por minuto informado.
- Ligação **recebida** nunca é recusada por franquia: quem ligou não fica sem atendimento.

O extrato (`usage_ledger`) ganhou a coluna `tts_characters`, com os caracteres mandados à síntese
de voz em cada linha.

## Chamadas ao mesmo tempo

`checkPacingAllowed` roda depois de `checkOutboundAllowed`, na mesma transação que cria a chamada.
Dois tetos seguram a ligação de saída a mais, com a recusa `concurrency_limit`:

- **da organização**: o `max_concurrent_calls` do plano;
- **da conta do provedor de síntese** (Cartesia): um número só, da instalação, o valor que a
  organização da plataforma informa em FinOps → Limites de operação (`takeProviderSlots`, em
  `packages/core/src/provider-slots.ts`). Ele conta as chamadas vivas de todas as organizações,
  recebidas e de saída, de qualquer processo de voz, porque todas dividem a mesma conta no provedor.
  O recado da caixa postal e a chamada simulada não usam o provedor e não contam. A conferência
  roda sob uma trava consultiva global (`pg_advisory_xact_lock`) na mesma transação que grava a
  chamada, então duas empresas ligando juntas não furam a última vaga. A vaga é a própria linha em
  `calls`: ela volta quando a chamada termina ou falha antes de conectar, e uma linha presa (o
  processo caiu) deixa de contar depois do maior tempo máximo de chamada dos agentes, mais 2
  minutos. Vazio é "sem limite por aqui". O valor da própria organização, se houver, só aperta o
  teto para ela.

A ligação **recebida** (operadora e WhatsApp) também passa pelas vagas do provedor. No teto, quem
liga pela operadora ouve sinal de ocupado, e a do WhatsApp continua tocando no celular; nos dois
casos a chamada fica recusada com o motivo `provider_limit_reached`, o evento `call_refused` e um
aviso no painel. Nunca uma chamada atendida e muda.

A recusa fica gravada como chamada `refused` com o evento `call_refused`, como qualquer recusa da
política de saída. Não há fila de espera: quem pediu a ligação recebe o código e tenta de novo.

## Redução de cadência por chamadas curtas

A rotina `watch_short_calls` confere, a cada 15 minutos enquanto a organização faz ligações de
saída, as ligações do dia **por linha e pela empresa inteira** (todas as linhas somadas, quando há
mais de uma). Quando mais de 1.000 ligações de saída foram feitas no dia e 75% ou mais delas foram
curtas:

- a linha entra em `cadence_breakers` para aquele dia; a empresa inteira entra com a linha `*`
  (`WHOLE_ORGANIZATION`), e então cada linha dela fica reduzida;
- sai um aviso crítico no painel e o evento `cadence_reduced`;
- até o fim do dia, a linha só faz o número de ligações por hora informado em FinOps (padrão: 60), e
  a ligação a mais é recusada com `cadence_reduced`.

A redução acaba sozinha na virada do dia, no fuso da organização.

O que conta como **curta** fica em FinOps → Limites de operação (só a plataforma grava), com o
padrão literal da especificação:

| Campo | Padrão | O que faz |
|---|---|---|
| `shortCallSeconds` | 6 | Segundos de conversa abaixo dos quais a ligação é curta |
| `shortCallInclusive` | não | Com sim, a ligação de exatamente esse tempo também conta (até, em vez de menos de) |
| `shortCallCountsUnanswered` | sim | A ligação de saída não completada conta como curta, com duração 0 |

Os números (6 s, 75%, 1.000 por dia, por tenant e por tronco) vêm da especificação do produto
recebida em 2026-11-16 (seção 6), que cita o Despacho 100/2026 da Anatel e fala em "duração inferior
a 6 segundos". O texto do despacho não foi conferido por quem escreveu este guia, inclusive se a
ligação não completada conta e se a fronteira é exclusiva: por isso os três campos acima existem.

Para o disjuntor ter efeito, o limite diário por linha da política de saída (`daily_cap_per_line`,
em Configurações → Ligações de saída) precisa passar de 1.000 ligações: com um teto menor, a linha
nunca chega ao volume que dispara a regra, e quem a protege é o próprio teto.

## Limite de caracteres por turno

No motor em pipeline (Deepgram, OpenRouter e Cartesia), o turno do agente tem alvo de 120 a 160
caracteres. A instrução pede isso ao modelo, e o limitador suave
(`packages/voice-engine/src/pipeline/turn-guard.ts`) garante:

- até 160 caracteres, o texto passa como chega;
- passou de 160, a frase em curso ainda termina, até 200;
- se não termina, o turno acaba na última palavra inteira antes de 160.

Nunca corta no meio de uma palavra. Os motores de voz direta não passam por aqui.

## Tela de FinOps

`GET /api/v1/finops` devolve o resumo do ciclo em curso: minutos usados contra a franquia,
ligações atendidas, caracteres de síntese, custo dos provedores, custo de telefonia, receita
(mensalidade mais excedente), margem bruta e custo por minuto contra a meta de R$ 0,28.

O custo dos provedores vem do extrato, que é medido em dólar. Para virar real, quem opera informa a
cotação; o custo de telefonia por minuto também é informado. Sem um dos dois, a tela mostra
"Sem dado" na margem em vez de um número errado.

## O que ficou de fora

- **Painel consolidado de todas as organizações.** A tela é por organização. Uma visão que
  atravessa organizações precisa de um papel de administrador da plataforma, que ainda não existe.
- **Fila de espera de ligações de saída.** O teto recusa; não enfileira.
- **Prioridade de fila por plano** (Growth, Scale). Depende da fila acima.
- **Voz clonada como adicional do plano Pro.** Não há cobrança de adicional.
- **Liberar a cadência reduzida antes do fim do dia.** Hoje ela só acaba sozinha.
- **Fala do agente abaixo de 50% do tempo da chamada.** O limite de caracteres ajuda, mas a
  proporção não é medida.

## Decisões em aberto

Estes pedidos seguem o formato do [`GOVERNANCE.md`](../../GOVERNANCE.md). Enquanto ninguém
responde, vale o padrão indicado.

### Decisão: quantas chamadas ao mesmo tempo cada plano inclui?

**Quem decide:** dono do projeto
**O que está parado esperando:** nada; o padrão já está em uso.

- **A.** Starter 2, Pro 3, Growth 4, Scale 8. Custo: nenhum, é o que está no código.
- **B.** Outros números, definidos pelo comercial. Custo: uma linha em `PLAN_CATALOG`; quem já
  contratou mantém o valor gravado até trocar de plano.
- **C.** Sem teto por plano. Custo: um cliente pequeno pode ocupar a conta inteira do provedor de
  síntese.

**Recomendação:** A, até o comercial fechar os números.
**Se ninguém responder em 14 dias, vale:** A.

### Decisão: quem pode trocar o plano de uma organização?

**Quem decide:** dono do projeto
**O que está parado esperando:** a venda como serviço para vários clientes.

- **A.** Dono e administrador da própria organização, como toda configuração. Custo: num serviço
  para vários clientes, o cliente consegue trocar o próprio plano pela tela.
- **B.** Só um administrador da plataforma, ou a API de provisionamento. Custo: exige o papel de
  administrador da plataforma.
- **C.** Não fazer. Custo: o plano só mudaria por acesso direto ao banco, o que a regra de
  configuração por tela não aceita.

**Recomendação:** B, quando o papel existir; até lá, A.
**Se ninguém responder em 14 dias, vale:** A.

### Decisão: o teto da conta do provedor de síntese é um número da instalação ou de cada organização?

**Quem decide:** mantenedores
**O que está parado esperando:** nada; o padrão já está em uso.

- **A.** Cada organização informa o teto, e a conta das chamadas em curso é de todo o processo de
  voz. Custo: organizações que dividem a mesma conta precisam informar o mesmo número.
- **B.** Um número só, da instalação. Custo: precisa de uma configuração que não pertence a
  nenhuma organização, e de quem possa alterá-la.
- **C.** Não fazer. Custo: disparo em lote esbarra no limite do provedor e a chamada falha depois
  de atendida.

**Recomendação:** A agora; B junto com o papel de administrador da plataforma.
**Se ninguém responder em 14 dias, vale:** A.
**Resolvida em 16/11/2026:** B. O papel de plataforma passou a existir (só a plataforma grava os
limites), e o valor dela virou o teto da instalação. A auditoria de 16/11 mostrou o custo de A: uma
empresa sem o número informado ficava sem limite, e a ligação recebida não contava.
