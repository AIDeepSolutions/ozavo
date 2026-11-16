import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { prepareProduction, productionInput } from "./prepare-production";

it.each([0o022, 0o077])("prepara artefatos legíveis no contêiner com umask %s e segredos separados", async mask => {
  const previousMask = process.umask(mask);
  const dir = await mkdtemp(join(tmpdir(), "ozavo-prepare-"));
  try {
    const tls = join(dir, "tls"); await mkdir(tls);
    const key = join(tls, "key.pem"); const cert = join(tls, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=ozavo.example", "-addext", "subjectAltName=DNS:ozavo.example", "-keyout", key, "-out", cert], { stdio: "ignore" });
    const input = { databaseUrl: "postgres://ozavo_app:invented@db.example.supabase.co:5432/postgres?sslmode=verify-full",
      systemDatabaseUrl: "postgres://ozavo_system:invented@db.example.supabase.co:5432/postgres?sslmode=verify-full",
      migrationDatabaseUrl: "postgres://owner:invented@db.example.supabase.co:5432/postgres?sslmode=verify-full",
      publicUrl: "https://ozavo.example", publicIp: "198.51.100.7", tlsCertificate: cert, tlsPrivateKey: key, localMinio: true as const };
    const target = join(dir, "production");
    // Sem S3 gerenciado, o espelho não oficial do MinIO só entra pedido.
    const { localMinio: _minio, ...withoutStorage } = input;
    expect(productionInput.safeParse(withoutStorage).success).toBe(false);
    // O teste roda como o "usuário do Asterisk": a chave fecha sem trocar dono.
    expect(await prepareProduction(target, input, { asteriskUid: process.getuid?.() ?? 0 })).toEqual([]);
    const app = await readFile(join(target, "app.env"), "utf8");
    expect(app).not.toContain("MIGRATION_DATABASE_URL"); expect(app).not.toContain("S3_SECRET_ACCESS_KEY");
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    expect((await stat(join(target, "app.env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(target, "asterisk/generated/tls"))).mode & 0o777).toBe(0o755);
    for (const file of ["pjsip.conf", "ari.conf", "http.conf", "extensions.conf", "rtp.conf", "tls/server.crt"]) {
      expect((await stat(join(target, "asterisk/generated", file))).mode & 0o777, file).toBe(0o644);
    }
    // A chave privada do certificado de produção só para o Asterisk.
    expect((await stat(join(target, "asterisk/generated/tls/server.key"))).mode & 0o777).toBe(0o600);
    const compose = parse(await readFile(join(target, "docker-compose.yml"), "utf8"));
    expect(compose.services.postgres).toBeUndefined();
    expect(compose.services.migrate.profiles).toEqual(["admin"]);
    expect(compose.services.asterisk.ports[0]).toBe("5061:5061/tcp");
    expect(compose.services.minio.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(await readFile(join(target, "asterisk/generated/pjsip.conf"), "utf8")).toContain("external_media_address=198.51.100.7");
    await expect(prepareProduction(target, input)).rejects.toThrow();
    expect(await readdir(target)).toContain("archive.env");
    for (const field of ["databaseUrl", "systemDatabaseUrl", "migrationDatabaseUrl"] as const) {
      expect(productionInput.safeParse({ ...input, [field]: input[field].replace(":5432", ":6543") }).success, field).toBe(false);
    }
  } finally { process.umask(previousMask); await rm(dir, { recursive: true, force: true }); }
});

it("sem poder passar a chave TLS ao usuário do Asterisk, deixa-a legível para o TLS subir e avisa com o comando", async () => {
  if (process.getuid?.() === 0) return; // root troca qualquer dono: o recuo não acontece.
  const dir = await mkdtemp(join(tmpdir(), "ozavo-prepare-key-"));
  try {
    const tls = join(dir, "tls"); await mkdir(tls);
    const key = join(tls, "key.pem"); const cert = join(tls, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=ozavo.example", "-addext", "subjectAltName=DNS:ozavo.example", "-keyout", key, "-out", cert], { stdio: "ignore" });
    const input = { databaseUrl: "postgres://ozavo_app:invented@db.example.supabase.co:5432/postgres?sslmode=verify-full",
      systemDatabaseUrl: "postgres://ozavo_system:invented@db.example.supabase.co:5432/postgres?sslmode=verify-full",
      migrationDatabaseUrl: "postgres://owner:invented@db.example.supabase.co:5432/postgres?sslmode=verify-full",
      publicUrl: "https://ozavo.example", publicIp: "198.51.100.7", tlsCertificate: cert, tlsPrivateKey: key, localMinio: true };
    const target = join(dir, "production");
    const warnings = await prepareProduction(target, input, { asteriskUid: 4242 });
    expect(warnings).toEqual([expect.stringContaining("sudo chown 4242:4242")]);
    expect((await stat(join(target, "asterisk/generated/tls/server.key"))).mode & 0o777).toBe(0o644);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
