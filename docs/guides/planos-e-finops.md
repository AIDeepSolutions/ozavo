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
trocar o plano de outra empresa: hoje isso se faz pelo provisionamento. A [integração nativa com o Asaas](asaas-nativo.md) também contrata e troca planos, inclusive
Personalizado, pela mesma função e sem orquestrador externo. Cada troca
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
- **da conta do provedor de síntese** (Cartesia): o valor informado em FinOps → Limites de operação.
  Este conta as chamadas em curso de todas as organizações do processo de voz, porque elas dividem
  a mesma conta no provedor. Vazio é "sem limite por aqui".

A recusa fica gravada como chamada `refused` com o evento `call_refused`, como qualquer recusa da
política de saída. Não há fila de espera: quem pediu a ligação recebe o código e tenta de novo.

## Redução de cadência por chamadas curtas

A rotina `watch_short_calls` confere, a cada 15 minutos enquanto a organização faz ligações de
saída, as ligações do dia por linha. Quando mais de 1.000 ligações de saída foram feitas no dia e
75% ou mais delas foram atendidas e duraram menos de 6 segundos:

- a linha entra em `cadence_breakers` para aquele dia;
- sai um aviso crítico no painel e o evento `cadence_reduced`;
- até o fim do dia, a linha só faz o número de ligações por hora informado em FinOps (padrão: 60), e
  a ligação a mais é recusada com `cadence_reduced`.

A redução acaba sozinha na virada do dia, no fuso da organização.

Os números (6 s, 75%, 1.000 por dia) vêm da especificação do produto recebida em 2026-11-16, que
cita o Despacho 100/2026 da Anatel. O texto do despacho não foi conferido por quem escreveu este
guia, inclusive a definição exata de "chamada curta".

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
