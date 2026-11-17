/** Por que um endereço de webhook não serve. Cada código tem frase própria no painel. */
export type WebhookUrlProblem = "invalid" | "https_required" | "url_credentials" | "port_not_allowed";

/**
 * O que se confere no endereço antes de gravar e de novo a cada entrega (o que é de rede, como o DNS,
 * fica com `assertPublicDestination`): só https, sem usuário nem senha, e porta 443 ou de 1024 a 65535.
 * Porta baixa (22, 25, 3306...) é serviço de outra coisa, não um receptor de webhook.
 */
export function checkWebhookUrl(raw: string): WebhookUrlProblem | null {
  if (!URL.canParse(raw)) return "invalid";
  const url = new URL(raw);
  if (url.protocol !== "https:") return "https_required";
  if (url.username !== "" || url.password !== "") return "url_credentials";
  // `new URL` apaga a porta padrão: vazio quer dizer 443.
  if (url.port !== "") {
    const port = Number(url.port);
    if (port !== 443 && !(port >= 1024 && port <= 65535)) return "port_not_allowed";
  }
  return null;
}

/**
 * O endereço como pode aparecer em evento, lista e erro: esquema, host (com a porta) e caminho. Sem
 * usuário, senha, query string nem fragmento: é onde as pessoas põem `?token=`.
 */
export function redactWebhookUrl(raw: string): string {
  if (!URL.canParse(raw)) return "[invalid url]";
  const url = new URL(raw);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/** Tira de um texto de erro qualquer endereço completo e o que vem depois de `?`. */
export function scrubWebhookError(message: string, raw: string): string {
  return message.replaceAll(raw, redactWebhookUrl(raw)).replace(/\?[^\s"')]*/g, "?…").slice(0, 200);
}
