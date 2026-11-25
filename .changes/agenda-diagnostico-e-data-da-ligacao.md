---
impact: new_capability
section: fixed
title: O agente sabe a data e a hora da ligação, e a falha da agenda deixa o motivo na linha do tempo
---

O agente passa a receber, no começo de cada ligação, o dia da semana, a data e a hora no fuso da agenda (Brasília, se a empresa não definiu outro), para entender "hoje", "amanhã" e "sexta" ao consultar horários e nunca oferecer data que já passou. Quando a consulta ou a reserva na agenda falha, o `tool_result` na linha do tempo ganha, em "Detalhe para o operador", o motivo técnico (erro de rede ou resposta do Cal.com, sem chave, e-mail nem telefone, e sem chegar ao modelo); antes só aparecia que a agenda não respondeu. A consulta de horários ganha uma segunda tentativa quando a conexão falha na hora e a conexão tenta o endereço IPv4 primeiro. Sem horário livre no dia, o agente é orientado a dizer que não achou horário nesse dia e perguntar por outro. Quem já instalou não precisa fazer nada. Crédito: @AIDeepSolutions.
