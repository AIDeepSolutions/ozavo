import { randomBytes, createPrivateKey, X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, chmod } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));
const databaseUrl = z.url().refine(value => {
  const url = new URL(value);
  return ["postgres:", "postgresql:"].includes(url.protocol) &&
    /\.(supabase\.co|supabase\.com)$/.test(url.hostname) && url.searchParams.get("sslmode") === "verify-full";
});
export const productionInput = z.object({
  databaseUrl: databaseUrl.refine(value => /^ozavo_app(?:\.[a-zA-Z0-9_-]+)?$/.test(decodeURIComponent(new URL(value).username))),
  systemDatabaseUrl: databaseUrl.refine(value => new URL(value).port !== "6543" && /^ozavo_system(?:\.[a-zA-Z0-9_-]+)?$/.test(decodeURIComponent(new URL(value).username)), "LISTEN needs a session connection with the system role"),
  migrationDatabaseUrl: databaseUrl.refine(value => new URL(value).port !== "6543"),
  publicUrl: z.url().refine(value => new URL(value).protocol === "https:"),
  publicIp: z.ipv4(),
  tlsCertificate: z.string().refine(isAbsolute), tlsPrivateKey: z.string().refine(isAbsolute),
  // Reutilizar numa atualização: trocar esta chave tornaria segredos e gravações ilegíveis.
  secretKey: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  s3: z.object({ endpoint: z.url().refine(value => new URL(value).protocol === "https:"),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), region: z.string().min(1),
    accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }).optional(),
});
const hex = () => randomBytes(32).toString("hex");
function envText(values: Record<string, string>): string {
  // Env_file raw não interpola $ de senhas. Valores não podem injetar nova linha.
  for (const value of Object.values(values)) if (/[\r\n\0]/.test(value)) throw new Error("Environment value contains a line break");
  return Object.entries(values).map(([key, value]) => `${key}='${value.replaceAll("'", "\\'")}'`).join("\n") + "\n";
}

/** Só prepara arquivos em diretório novo; não acessa banco, Docker, rede ou instalação existente. */
export async function prepareProduction(target: string, input: unknown): Promise<void> {
  if (!isAbsolute(target) || resolve(target) === "/" || resolve(target) === root) throw new Error("Use a new absolute directory");
  const data = productionInput.parse(input);
  const certificate = await readFile(data.tlsCertificate);
  const privateKey = await readFile(data.tlsPrivateKey);
  const cert = new X509Certificate(certificate);
  if (!cert.checkPrivateKey(createPrivateKey(privateKey)) || !cert.checkHost(new URL(data.publicUrl).hostname)) throw new Error("TLS certificate does not match the host/key");
  await mkdir(target, { mode: 0o700 }); // EEXIST recusa sobrescrever uma instalação.
  const generated = join(target, "asterisk/generated");
  await mkdir(join(generated, "tls"), { recursive: true });
  const ari = hex();
  const accessKeyId = data.s3?.accessKeyId ?? randomBytes(16).toString("hex");
  const secretAccessKey = data.s3?.secretAccessKey ?? hex();
  const writeEnv = async (file: string, values: Record<string, string>) => writeFile(join(target, file), envText(values), { mode: 0o600 });
  await writeEnv("app.env", {
    DATABASE_URL: data.databaseUrl, SYSTEM_DATABASE_URL: data.systemDatabaseUrl,
    OZAVO_SECRET_KEY: data.secretKey ?? hex(), PUBLIC_URL: data.publicUrl,
    ARI_PASSWORD: ari, INTERNAL_TOKEN: hex(), PUBLIC_IP: data.publicIp,
    VOICE_INTERNAL_URL: "http://voice:8090", RECORDINGS_DIR: "/recordings",
  });
  await writeEnv("migrate.env", { MIGRATION_DATABASE_URL: data.migrationDatabaseUrl });
  await writeEnv("archive.env", { S3_ENDPOINT: data.s3?.endpoint ?? "http://minio:9000",
    S3_BUCKET: data.s3?.bucket ?? "recordings", S3_REGION: data.s3?.region ?? "us-east-1",
    S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey });
  await writeEnv("minio.env", { MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey });
  await writeEnv(".env", { PUBLIC_HOST: new URL(data.publicUrl).hostname,
    COMPOSE_PROFILES: data.s3 ? "" : "minio", OZAVO_VERSION: "dev" });
  const replacements: Record<string, string> = { PUBLIC_IP: data.publicIp, ARI_PASSWORD: ari, RTP_START: "10000", RTP_END: "10200" };
  for (const [template, name] of [["extensions.conf", "extensions.conf"], ["http.conf", "http.conf"], ["ari.conf.tmpl", "ari.conf"], ["rtp.conf.tmpl", "rtp.conf"], ["pjsip.production.conf.base", "pjsip.conf"]]) {
    const source = await readFile(join(root, "deploy/asterisk", template ?? ""), "utf8");
    await writeFile(join(generated, name ?? ""), source.replace(/\$\{([A-Z_]+)\}/g, (original: string, key: string) => replacements[key] ?? original), { mode: 0o644 });
  }
  // O diretório pai 0700 protege a chave; o Asterisk no contêiner precisa ler o bind mount.
  await writeFile(join(generated, "tls/server.crt"), certificate, { mode: 0o644 });
  await writeFile(join(generated, "tls/server.key"), privateKey, { mode: 0o644 });
  await chmod(generated, 0o700);
  await copyFile(join(root, "deploy/Caddyfile"), join(target, "Caddyfile"));
  const compose = parse(await readFile(join(root, "deploy/docker-compose.supabase.yml"), "utf8"), { merge: true }) as { services: Record<string, { build?: { context: string } }> };
  for (const service of Object.values(compose.services)) if (service.build) service.build.context = root;
  await writeFile(join(target, "docker-compose.yml"), stringify(compose));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    await prepareProduction(process.argv[2] ?? "", JSON.parse(Buffer.concat(chunks).toString()));
    process.stdout.write("Arquivos preparados. Nenhuma migration ou implantação executada.\n");
  } catch {
    process.stderr.write("Preparo recusado. Confira diretório novo, URLs Supabase com TLS, conexão de sessão e certificado correspondente. Nenhum segredo foi impresso.\n");
    process.exitCode = 1;
  }
}
