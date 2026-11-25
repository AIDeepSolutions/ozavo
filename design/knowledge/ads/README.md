# Fontes de conhecimento da AI Deep Solutions

Textos institucionais usados como base de conhecimento de exemplo do agente da Empresa Demo:

- `institucional-e-servicos.md`: quem é a empresa, serviços, stack e casos (clientes sem nome).
- `faq-comercial-e-institucional.md`: perguntas e respostas comerciais.

Revisados em 25/11/2026: sem telefone, e-mail, endereço, documento de pessoa, senha ou chave. O contexto temporário do evento de
30/09/2026 não está aqui de propósito (cita uma pessoa e uma regra interna vencida).

Para indexar numa empresa:

```bash
pnpm --filter @ozavo/routines run import-knowledge -- --org <id da empresa> --name "AI Deep Solutions - Institucional e Serviços" \
  --file design/knowledge/ads/institucional-e-servicos.md --agent <id do agente>
```
