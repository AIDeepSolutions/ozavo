import { describe, expect, it } from "vitest";
import { parseUdpOnlyHosts, renderTrunksConf, type TrunkConfig } from "./trunks";

/**
 * Linha TLS: a porta 5060 é a do SIP sem cifra (auditoria A16), e o domínio do PAI é o da
 * operadora, não o IP público da instalação (auditoria A8). O PJSIP monta o host do
 * P-Asserted-Identity a partir do `from_domain` do endpoint.
 */
const ID = "0a000000-0000-4000-8000-000000000001";
const ORG = "10000000-0000-4000-8000-00000000000a";
const base: TrunkConfig = {
  id: ID, host: "sip.operadora.example", username: "conta100", password: "s3nha", authMode: "register",
  publicIp: "203.0.113.10", organizationId: ORG, sipTls: true, callerId: "+5511912345678", callerDisplayName: "Ozavo",
};
const lineOf = (conf: string, key: string): string[] => conf.split("\n").filter((line) => line.startsWith(`${key}=`));

describe("linha TLS", () => {
  it("troca a porta 5060 escrita no endereço pela 5061 no destino e no registro", () => {
    const { conf } = renderTrunksConf([{ ...base, host: "sip.operadora.example:5060" }]);
    expect(lineOf(conf, "contact")).toEqual(["contact=sip:sip.operadora.example:5061;transport=tls"]);
    expect(lineOf(conf, "server_uri")).toEqual(["server_uri=sip:sip.operadora.example:5061;transport=tls"]);
    expect(lineOf(conf, "client_uri")).toEqual(["client_uri=sip:conta100@sip.operadora.example:5061;transport=tls"]);
    expect(conf).not.toContain(":5060");
  });

  it("mantém uma porta TLS diferente da padrão quando a operadora a publica", () => {
    const { conf } = renderTrunksConf([{ ...base, host: "sip.operadora.example:5081" }]);
    expect(lineOf(conf, "contact")).toEqual(["contact=sip:sip.operadora.example:5081;transport=tls"]);
  });

  it("com o endereço por nome, o PAI leva o domínio da operadora", () => {
    const { conf } = renderTrunksConf([{ ...base, host: "sip.operadora.example:5061" }]);
    expect(lineOf(conf, "from_domain")).toEqual(["from_domain=sip.operadora.example"]);
    expect(conf).toContain("send_pai=yes");
  });

  it("sem TLS, a linha continua com o IP público no from_domain", () => {
    const { conf } = renderTrunksConf([{ ...base, sipTls: false }]);
    expect(lineOf(conf, "from_domain")).toEqual(["from_domain=203.0.113.10"]);
  });
});

/** TEMPORÁRIO (Telera, 25/11/2026): na produção só o servidor listado pode ter linha sem TLS. */
describe("exceção temporária de UDP na produção", () => {
  const telera: TrunkConfig = { ...base, host: "sip.telera.com.br", sipTls: false };
  const other: TrunkConfig = { ...base, id: "0a000000-0000-4000-8000-000000000002", host: "sip.outra.example", sipTls: false };

  it("escreve a linha sem TLS do servidor listado, por UDP, e recusa a de outro servidor", () => {
    const { conf, skipped, emitted } = renderTrunksConf([telera, other], ["sip.telera.com.br"]);
    expect(emitted).toEqual([ID]);
    expect(lineOf(conf, "transport")).toEqual(["transport=transport-udp", "transport=transport-udp"]);
    expect(skipped).toEqual([{ id: other.id, reason: expect.stringContaining("without TLS") }]);
  });

  it("lista vazia (padrão da produção): nenhuma linha sem TLS; a linha TLS segue normal", () => {
    const { skipped, emitted } = renderTrunksConf([telera, { ...base, id: other.id }], []);
    expect(skipped.map((s) => s.id)).toEqual([ID]);
    expect(emitted).toEqual([other.id]);
  });

  it("ignora porta e caixa do endereço ao comparar", () => {
    expect(renderTrunksConf([{ ...telera, host: "SIP.Telera.com.br:5060" }], ["sip.telera.com.br"]).emitted).toEqual([ID]);
  });

  it("sem restrição (instalação comunitária), UDP vale para qualquer linha", () => {
    expect(renderTrunksConf([telera, other]).emitted).toEqual([ID, other.id]);
  });

  it("lê a variável: ausente é sem restrição; vazia é só TLS", () => {
    expect(parseUdpOnlyHosts(undefined)).toBeNull();
    expect(parseUdpOnlyHosts("")).toEqual([]);
    expect(parseUdpOnlyHosts(" a.example , b.example ")).toEqual(["a.example", "b.example"]);
  });
});
