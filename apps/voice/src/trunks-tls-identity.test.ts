import { describe, expect, it } from "vitest";
import { renderTrunksConf, type TrunkConfig } from "./trunks";

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
