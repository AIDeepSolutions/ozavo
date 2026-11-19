# API para sistemas de fora e cobrança nativa

Três coisas que um sistema de fora faz no Ozavo sem uma pessoa no painel: pedir uma ligação,
criar uma empresa e receber o que aconteceu. Tudo sai de uma **chave de API**, criada em
Configurações > Empresa e API. A chave aparece uma vez; o servidor guarda só um resumo dela.

Envie sempre no cabeçalho:

```
Authorization: Bearer ozk_...
```

Chave revogada, de empresa suspensa ou inexistente recebe `401`. Chave sem o escopo da rota recebe
`403`. Cada chave faz no máximo 60 pedidos por minuto (`429` acima disso).

## Pedir uma ligação (Speed-to-Lead)

Escopo `calls:outbound`.

```http
POST /api/v1/calls/outbound
Idempotency-Key: lead-42

{
  "toE164": "+5511988887777",
  "agentId": "opcional: sem ele, liga o agente padrão da empresa",
  "context": { "nome": "Ana", "interesse": "apartamento de 2 quartos" }
}
```

- `202` com `{ "callId": "...", "repeated": false }`: a ligação foi originada.
- O mesmo `Idempotency-Key` (ou `requestKey` no corpo) devolve a mesma ligação com `200` e
  `repeated: true`, sem ligar de novo. Use-o sempre que o integrador puder repetir o pedido.
- `context` vai para o agente como dado sobre a pessoa e o motivo, nunca como instrução. Até 8 KB.
- **Remarcar ou cancelar numa ligação de saída:** o agente só mexe num compromisso que ele mesmo marcou na ligação ou que o
  integrador informou em `context.appointmentIds` (até 50 textos de até 200 caracteres; qualquer outra forma é ignorada).
  O `context` vira `request_context` da chamada. A trava **nega por padrão** o id que não está lá, e a comparação é exata (maiúscula
  e espaço contam). Exemplo: `"context": { "nome": "Ana", "appointmentIds": ["apt_123"] }`. Ver
  [decisão 0021](../decisions/0021-modelo-haiku-e-perfis-do-agente.md).
- O pedido não passa pela fila de rotinas: vai direto ao processo de voz, que responde em até 5 s.
- A ligação passa pela mesma política de ligação de saída de qualquer outra: desligada de fábrica,
  janela de horário, teto diário por linha, tentativas por contato e lista de não ligar. A recusa
  volta com `422` e o código (`outbound_disabled`, `outside_window`, `do_not_call`,
  `daily_cap_reached`, `attempts_exhausted`). Esta rota não serve para disparo em massa.

## Criar uma empresa (provisionamento)

Escopo `tenants:provision`, que só a organização que administra a instalação pode emitir.
Esta API continua disponível para integrações externas. A cobrança pelo Asaas é **nativa** no
Ozavo: veja [configuração e recuperação](asaas-nativo.md). Nenhum orquestrador externo é necessário.

```http
POST /api/v1/tenants/provision

{
  "source": "external",
  "externalRef": "contrato_000123",
  "company": { "legalName": "Clínica Exemplo Ltda", "tradeName": "Clínica Exemplo", "cnpj": "11.222.333/0001-81" },
  "owner": { "name": "Dona da clínica", "email": "dona@clinica.example" },
  "plan": { "code": "pro", "monthlyMinutes": 750 },
  "agent": { "personaName": "Nico", "voiceId": "opcional", "basePrompt": "opcional", "engine": "opcional" },
  "credentials": { "deepgram-openrouter-cartesia": "chave do motor, opcional" }
}
```

- `201` com a empresa, o agente, `ownerInviteUrl`, `ownerInviteExpiresAt` e `loginUrl`. Nenhuma senha
  sai na resposta: o dono abre o `ownerInviteUrl` (uso único, vale 7 dias) e escolhe a própria senha.
  Envie o link ao cliente, por e-mail ou WhatsApp. `ownerUserId` fica `null` até ele aceitar.
- O mesmo `source` + `externalRef` devolve a mesma empresa com `200`, sem criar outra. Se o dono
  ainda não aceitou, a resposta traz um `ownerInviteUrl` novo e o anterior deixa de valer; depois
  que ele entra, traz o `ownerUserId` e nenhum link.
- E-mail de dono já usado na instalação: `409 email_taken`.
- A empresa nasce com as ligações de saída desligadas. O plano fica gravado como vínculo; quem o
  aplica é o motor de planos.

## Receber o que aconteceu

O agente chama os webhooks cadastrados em Configurações > Integrações (ferramenta `call_webhook`),
e as rotinas entregam a eles depois da ligação (`deliver_webhook`). É por aí que um sistema de fora recebe o
resultado e repassa a qualquer CRM ou ERP.
