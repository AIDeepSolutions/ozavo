import { describe, expect, it } from "vitest";
import { PANEL_SOURCE, displayStatus, tenantOrigin } from "./platform-tenants";

describe("displayStatus", () => {
  it("a assinatura cancelada no Asaas vence o status do perfil", () => {
    expect(displayStatus("active", true)).toBe("cancelled");
    expect(displayStatus("suspended", true)).toBe("cancelled");
  });

  it("sem cancelamento, vale o perfil; sem perfil, a empresa está ativa", () => {
    expect(displayStatus("suspended", false)).toBe("suspended");
    expect(displayStatus("active", false)).toBe("active");
    expect(displayStatus(null, false)).toBe("active");
  });
});

describe("tenantOrigin", () => {
  it("distingue Asaas, esta tela e quem chamou a API", () => {
    expect(tenantOrigin("asaas")).toEqual({ kind: "asaas" });
    expect(tenantOrigin(PANEL_SOURCE)).toEqual({ kind: "panel" });
    expect(tenantOrigin("crm")).toEqual({ kind: "api", source: "crm" });
    expect(tenantOrigin(null)).toEqual({ kind: "unknown" });
  });
});
