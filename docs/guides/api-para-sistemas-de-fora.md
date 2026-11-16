# API para sistemas de fora (n8n, CRM, Asaas)

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
  `repeated: true`, sem ligar de novo. Use-o sempre que o n8n puder repetir o pedido.
- `context` vai para o agente como dado sobre a pessoa e o motivo, nunca como instrução. Até 8 KB.
- O pedido não passa pela fila de rotinas: vai direto ao processo de voz, que responde em até 5 s.
- A ligação passa pela mesma política de ligação de saída de qualquer outra: desligada de fábrica,
  janela de horário, teto diário por linha, tentativas por contato e lista de não ligar. A recusa
  volta com `422` e o código (`outbound_disabled`, `outside_window`, `do_not_call`,
  `daily_cap_reached`, `attempts_exhausted`). Esta rota não serve para disparo em massa.

## Criar uma empresa (provisionamento)

Escopo `tenants:provision`, que só a organização que administra a instalação pode emitir. O n8n
chama depois da assinatura do contrato e da confirmação do pagamento no Asaas.

```http
POST /api/v1/tenants/provision

{
  "source": "asaas",
  "externalRef": "sub_000123",
  "company": { "legalName": "Clínica Exemplo Ltda", "tradeName": "Clínica Exemplo", "cnpj": "11.222.333/0001-81" },
  "owner": { "name": "Dona da clínica", "email": "dona@clinica.example" },
  "plan": { "code": "pro", "monthlyMinutes": 750 },
  "agent": { "personaName": "Nico", "voiceId": "opcional", "basePrompt": "opcional", "engine": "opcional" },
  "credentials": { "deepgram-openrouter-cartesia": "chave do motor, opcional" }
}
```

- `201` com a empresa, o dono, o agente, `initialPassword` (só nesta resposta) e `loginUrl`.
  Entregue a senha inicial ao cliente por um canal seguro e peça que ele a troque em Sua conta.
- O mesmo `source` + `externalRef` devolve a mesma empresa com `200`, sem senha e sem criar outra.
- E-mail de dono já usado na instalação: `409 email_taken`.
- A empresa nasce com as ligações de saída desligadas. O plano fica gravado como vínculo; quem o
  aplica é o motor de planos.

## Receber o que aconteceu

O agente chama os webhooks cadastrados em Configurações > Integrações (ferramenta `call_webhook`),
e as rotinas entregam a eles depois da ligação (`deliver_webhook`). É por aí que o n8n recebe o
resultado e repassa a qualquer CRM ou ERP.
