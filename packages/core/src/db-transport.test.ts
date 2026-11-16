import { describe, expect, it } from "vitest";
import { databaseTransport, dbTransport } from "./db";

// Endereços inventados: nenhum aponta para banco de verdade.
describe("databaseTransport", () => {
  it("banco na rede privada não precisa de TLS", () => {
    expect(
      [
        "postgres://ozavo_app:x@postgres:5432/ozavo",
        "postgres://ozavo_app:x@localhost/ozavo",
        "postgres://ozavo_app:x@127.0.0.1:5432/ozavo",
        "postgres://ozavo_app:x@10.0.0.5/ozavo",
        "postgres://ozavo_app:x@172.20.0.3/ozavo",
        "postgres://ozavo_app:x@192.168.1.9/ozavo",
        "postgres://ozavo_app:x@[::1]/ozavo",
        "postgres://ozavo_app:x@db.internal/ozavo",
        "postgres:///ozavo?host=/var/run/postgresql",
      ].map(databaseTransport),
    ).toEqual(Array(9).fill("local"));
  });

  it("banco fora da rede: só verify-full ou verify-ca contam como verificado", () => {
    const remote = "postgres://ozavo_app:x@aws-0-sa-east-1.pooler.exemplo.com:5432/postgres";
    expect(databaseTransport(`${remote}?sslmode=verify-full`)).toBe("verified");
    expect(databaseTransport(`${remote}?sslmode=verify-ca`)).toBe("verified");
    expect(databaseTransport(`${remote}?sslmode=require`)).toBe("unverified");
    expect(databaseTransport(`${remote}?sslmode=no-verify`)).toBe("unverified");
    expect(databaseTransport(`${remote}?ssl=true`)).toBe("unverified");
    expect(databaseTransport(remote)).toBe("plaintext");
    expect(databaseTransport(`${remote}?sslmode=disable`)).toBe("plaintext");
  });

  it("IP público e faixa vizinha da privada são fora da rede", () => {
    expect(databaseTransport("postgres://a:b@172.32.0.1/x")).toBe("plaintext");
    expect(databaseTransport("postgres://a:b@203.0.113.7/x")).toBe("plaintext");
  });

  it("sem endereço ou com endereço ilegível não mede nada", () => {
    expect(databaseTransport(undefined)).toBe("local");
    expect(databaseTransport("não é endereço")).toBe("local");
  });
});

describe("dbTransport", () => {
  it("vale o pior entre a conexão de aplicação e a de sistema", () => {
    const verified = "postgres://a:b@db.exemplo.com/x?sslmode=verify-full";
    const plain = "postgres://a:b@db.exemplo.com/x";
    expect(dbTransport({ appUrl: verified, systemUrl: plain })).toBe("plaintext");
    expect(dbTransport({ appUrl: verified, systemUrl: verified })).toBe("verified");
    expect(dbTransport({ appUrl: "postgres://a:b@postgres/x" })).toBe("local");
  });
});
