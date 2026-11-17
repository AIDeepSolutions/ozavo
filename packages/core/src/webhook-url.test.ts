import { describe, expect, it } from "vitest";
import { checkWebhookUrl, redactWebhookUrl, scrubWebhookError } from "./webhook-url";

describe("checkWebhookUrl", () => {
  it("aceita https na 443 (explícita ou padrão) e portas de 1024 a 65535", () => {
    for (const url of ["https://h.example.com/x", "https://h.example.com:443/x", "https://h.example.com:1024/x", "https://h.example.com:8443/x", "https://h.example.com:65535/x"]) expect(checkWebhookUrl(url), url).toBeNull();
  });

  it("recusa porta abaixo de 1024 que não seja 443, e acima de 65535", () => {
    for (const port of [1, 21, 22, 25, 80, 8, 1023]) expect(checkWebhookUrl(`https://h.example.com:${port}/x`), String(port)).toBe("port_not_allowed");
    expect(checkWebhookUrl("https://h.example.com:65536/x")).toBe("invalid");
  });

  it("recusa http, usuário, senha e texto que não é URL", () => {
    expect(checkWebhookUrl("http://h.example.com/x")).toBe("https_required");
    expect(checkWebhookUrl("ftp://h.example.com/x")).toBe("https_required");
    expect(checkWebhookUrl("https://user@h.example.com/x")).toBe("url_credentials");
    expect(checkWebhookUrl("https://user:pass@h.example.com/x")).toBe("url_credentials");
    expect(checkWebhookUrl("https://:pass@h.example.com/x")).toBe("url_credentials");
    expect(checkWebhookUrl("não é url")).toBe("invalid");
  });
});

describe("redactWebhookUrl e scrubWebhookError", () => {
  it("guarda só esquema, host e caminho", () => {
    expect(redactWebhookUrl("https://u:p@h.example.com:8443/a/b?token=XYZ#frag")).toBe("https://h.example.com:8443/a/b");
    expect(redactWebhookUrl("lixo")).toBe("[invalid url]");
  });

  it("tira o endereço inteiro e a query de um texto de erro", () => {
    const url = "https://h.example.com/a?token=XYZ";
    const message = scrubWebhookError(`fetch failed for ${url} (retry ?token=XYZ&b=1)`, url);
    expect(message).not.toContain("XYZ");
    expect(message).toContain("https://h.example.com/a");
  });
});
