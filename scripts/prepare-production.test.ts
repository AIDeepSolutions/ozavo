import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { prepareProduction, productionInput } from "./prepare-production";

it("prepara diretório novo com segredos separados, TLS e Compose sem banco local nem migration automática", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ozavo-prepare-"));
  try {
    const tls = join(dir, "tls"); await mkdir(tls);
    const key = join(tls, "key.pem"); const cert = join(tls, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=ozavo.example", "-addext", "subjectAltName=DNS:ozavo.example", "-keyout", key, "-out", cert], { stdio: "ignore" });
    const input = { databaseUrl: "postgres://ozavo_app:invented@db.example.supabase.co:5432/postgres?sslmode=verify-full",
      systemDatabaseUrl: "postgres://ozavo_system:invented@db.example.supabase.co:5432/postgres?sslmode=verify-full",
      migrationDatabaseUrl: "postgres://owner:invented@db.example.supabase.co:5432/postgres?sslmode=verify-full",
      publicUrl: "https://ozavo.example", publicIp: "198.51.100.7", tlsCertificate: cert, tlsPrivateKey: key };
    const target = join(dir, "production");
    await prepareProduction(target, input);
    const app = await readFile(join(target, "app.env"), "utf8");
    expect(app).not.toContain("MIGRATION_DATABASE_URL"); expect(app).not.toContain("S3_SECRET_ACCESS_KEY");
    expect((await stat(join(target, "app.env"))).mode & 0o777).toBe(0o600);
    const compose = parse(await readFile(join(target, "docker-compose.yml"), "utf8"));
    expect(compose.services.postgres).toBeUndefined();
    expect(compose.services.migrate.profiles).toEqual(["admin"]);
    expect(compose.services.asterisk.ports[0]).toBe("5061:5061/tcp");
    expect(compose.services.minio.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(await readFile(join(target, "asterisk/generated/pjsip.conf"), "utf8")).toContain("external_media_address=198.51.100.7");
    await expect(prepareProduction(target, input)).rejects.toThrow();
    expect(await readdir(target)).toContain("archive.env");
    expect(productionInput.safeParse({ ...input, systemDatabaseUrl: input.systemDatabaseUrl.replace(":5432", ":6543") }).success).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
