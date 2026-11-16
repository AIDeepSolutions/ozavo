# Pedidos de decisão da auditoria de 16/11/2026

A auditoria da especificação (itens A23 e C-P2 6) deixou quatro pontos que nenhuma regra do
[`GOVERNANCE.md`](../../GOVERNANCE.md) resolve. Cada um está no formato de pedido de decisão, com o
padrão que vale se ninguém responder, para virar issue. Nada aqui foi implementado além do que a
seção "Se ninguém responder" diz que já vale hoje.

## Decisão: o plano Growth tem prioridade na fila de ligações de saída?

**Quem decide:** dono do projeto
**O que está parado esperando:** item "Growth: prioridade intermediária na fila" da especificação

### Opções
- **A.** Criar uma fila de saída: a ligação que passa do teto de concorrência espera em vez de ser
  recusada, e a ordem respeita o plano (Scale, Growth, Pro, Starter). Custo: um consumidor novo na
  fila, prazo de espera, ligação que expira sem sair e tela para ver a fila. É o maior dos quatro.
- **B.** Manter a recusa (`concurrency_limit`) e dar ao Growth e ao Scale um teto de canais maior,
  como já acontece (3/4/8). Custo: nenhum; a "prioridade" vira capacidade, não ordem.
- **C.** Não fazer. Custo: o texto da especificação continua sem correspondência.

### Recomendação
B, porque quem chama a API já recebe a recusa na hora e pode tentar de novo; uma fila escondida
atrasa ligações sem que o sistema de fora saiba, e o projeto recusa facilitar disparo em massa
(antipadrão 16).

### Se ninguém responder em 14 dias, vale: B

### Não medido
Quantas recusas por `concurrency_limit` uma empresa real recebe por dia.

## Decisão: voz clonada é complemento só do plano Pro?

**Quem decide:** dono do projeto
**O que está parado esperando:** item "Pro: voz clonada como add-on" da especificação

### Opções
- **A.** Marcar na tela quais vozes são clonadas e recusar voz clonada fora do Pro (ou fora de quem
  contratou o complemento). Custo: o Ozavo não sabe, pelo identificador da Cartesia, se a voz é
  clonada; exige consultar a conta do provedor ou o operador declarar.
- **B.** Tratar como regra comercial fora do produto: quem vende o plano só cadastra voz clonada
  para quem pagou. Custo: nada impede, no sistema, uma empresa de colar o identificador de uma voz
  clonada.
- **C.** Não fazer.

### Recomendação
B, porque o projeto é aberto e sem versão paga, e uma trava que depende de consultar o provedor
cria uma dependência de nuvem para salvar uma configuração.

### Se ninguém responder em 14 dias, vale: B

### Não medido
Se a API da Cartesia diz, para um identificador, que a voz é clonada.

## Decisão: os tetos de canais por plano (2/3/4/8) ficam como estão?

**Quem decide:** dono do projeto
**O que está parado esperando:** a especificação só define minutos por plano; os tetos foram
escolhidos na implementação da Fase 3

### Opções
- **A.** Manter 2/3/4/8 (Starter, Pro, Growth, Scale).
- **B.** Outros valores, informados pelo dono.
- **C.** Sem teto por plano, só o teto da conta do provedor de voz.

### Recomendação
A, porque a conta atual da Cartesia aceita poucos contextos ao mesmo tempo, e o teto por plano
impede uma empresa de ocupar todos.

### Se ninguém responder em 14 dias, vale: A

### Não medido
O limite de contextos simultâneos de cada plano da Cartesia.

## Decisão: o limite de requisições por chave de API precisa valer entre réplicas do painel?

**Quem decide:** mantenedores
**O que está parado esperando:** C-P2 6 da auditoria

Hoje o limite (`apps/panel/src/server/rate-limit.ts`, 60 por minuto por chave em
`server/api-auth.ts`, e 5 testes de chave de motor a cada 10 minutos em `server/engine-key.ts`)
fica na memória do processo do painel. Com uma réplica, que é o que a instalação e o Coolify sobem,
ele vale inteiro. Com N réplicas, cada uma conta separado e o limite efetivo vira N vezes maior.

### Opções
- **A.** Guardar a contagem no Postgres. Custo: uma escrita por requisição de API.
- **B.** Manter em memória e documentar que vale por réplica.
- **C.** Não fazer.

### Recomendação
B, porque o painel roda com uma réplica e a escrita por requisição pesa mais do que o risco.

### Se ninguém responder em 14 dias, vale: B

### Não medido
Se alguma instalação roda o painel com mais de uma réplica.
