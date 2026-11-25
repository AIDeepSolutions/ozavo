import { randomBytes, createPrivateKey, X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, chmod, chown } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));
const databaseUrl = z.url().refine(value => {
  const url = new URL(value);
  return ["postgres:", "postgresql:"].includes(url.protocol) && url.port !== "6543" &&
    /\.(supabase\.co|supabase\.com)$/.test(url.hostname) && url.searchParams.get("sslmode") === "verify-full";
});
export const productionInput = z.object({
  databaseUrl: databaseUrl.refine(value => /^ozavo_app(?:\.[a-zA-Z0-9_-]+)?$/.test(decodeURIComponent(new URL(value).username))),
  systemDatabaseUrl: databaseUrl.refine(value => new URL(value).port !== "6543" && /^ozavo_system(?:\.[a-zA-Z0-9_-]+)?$/.test(decodeURIComponent(new URL(value).username)), "must use a session connection with the system role"),
  migrationDatabaseUrl: databaseUrl.refine(value => new URL(value).port !== "6543"),
  publicUrl: z.url().refine(value => new URL(value).protocol === "https:"),
  publicIp: z.ipv4(),
  tlsCertificate: z.string().refine(isAbsolute), tlsPrivateKey: z.string().refine(isAbsolute),
  // Reutilizar numa atualização: trocar esta chave tornaria segredos e gravações ilegíveis.
  secretKey: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  s3: z.object({ endpoint: z.url().refine(value => new URL(value).protocol === "https:"),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), region: z.string().min(1),
    accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }).optional(),
  // O MinIO da composição é um espelho não oficial (a imagem oficial não é mais pública: 16/11/2026).
  // Sem `s3`, ele só entra com o pedido explícito, e é para bancada: em produção, S3 gerenciado.
  localMinio: z.literal(true).optional(),
  // TEMPORÁRIO (Telera, 25/11/2026): servidor de operadora que só fala SIP por UDP. Só a linha
  // cadastrada para ele pode ficar sem TLS; abre 5060/udp. Sem este campo a produção é só TLS.
  // Ver docs/decisions/2026-11-25-udp-temporario-telera.md.
  temporaryUdpHost: z.string().regex(/^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/, "must be one server name").optional(),
}).refine(value => value.s3 !== undefined || value.localMinio === true, { message: "Inform s3 (managed storage), or localMinio: true to accept the unofficial MinIO mirror", path: ["s3"] });
const hex = () => randomBytes(32).toString("hex");
function envText(values: Record<string, string>): string {
  // Env_file raw não interpola $ de senhas. Valores não podem injetar nova linha.
  for (const value of Object.values(values)) if (/[\r\n\0]/.test(value)) throw new Error("Environment value contains a line break");
  return Object.entries(values).map(([key, value]) => `${key}='${value.replaceAll("'", "\\'")}'`).join("\n") + "\n";
}

/**
 * O usuário do Asterisk na imagem fixada: `asterisk`, uid e gid 1000 (a imagem faz `usermod -u 1000
 * -g 1000 asterisk` e roda `asterisk -U asterisk`; conferido na configuração de
 * andrius/asterisk@sha256:927d4c98..., 20.20.1, em 16/11/2026). O mesmo de `install/_common.sh`.
 */
export const ASTERISK_UID = 1000;

/**
 * Só prepara arquivos em diretório novo; não acessa banco, Docker, rede ou instalação existente.
 * Devolve os avisos que quem roda precisa ler (a chave TLS que não pôde ser fechada).
 */
export async function prepareProduction(target: string, input: unknown, options: { asteriskUid?: number } = {}): Promise<string[]> {
  const warnings: string[] = [];
  if (!isAbsolute(target) || resolve(target) === "/" || resolve(target) === root) throw new Error("Use a new absolute directory");
  const data = productionInput.parse(input);
  const certificate = await readFile(data.tlsCertificate);
  const privateKey = await readFile(data.tlsPrivateKey);
  const cert = new X509Certificate(certificate);
  if (!cert.checkPrivateKey(createPrivateKey(privateKey)) || !cert.checkHost(new URL(data.publicUrl).hostname)) throw new Error("TLS certificate does not match the host/key");
  await mkdir(target, { mode: 0o700 }); // EEXIST recusa sobrescrever uma instalação.
  const generated = join(target, "asterisk/generated");
  await mkdir(join(generated, "tls"), { recursive: true });
  await chmod(join(generated, "tls"), 0o755);
  const ari = hex();
  const accessKeyId = data.s3?.accessKeyId ?? randomBytes(16).toString("hex");
  const secretAccessKey = data.s3?.secretAccessKey ?? hex();
  const writeEnv = async (file: string, values: Record<string, string>) => writeFile(join(target, file), envText(values), { mode: 0o600 });
  await writeEnv("app.env", {
    DATABASE_URL: data.databaseUrl, SYSTEM_DATABASE_URL: data.systemDatabaseUrl,
    OZAVO_SECRET_KEY: data.secretKey ?? hex(), PUBLIC_URL: data.publicUrl,
    ARI_PASSWORD: ari, INTERNAL_TOKEN: hex(), PUBLIC_IP: data.publicIp,
    VOICE_INTERNAL_URL: "http://voice:8090", RECORDINGS_DIR: "/recordings",
    // Vazio = só TLS. Com valor, só a linha desse servidor pode ficar sem TLS (temporário).
    OZAVO_UDP_ONLY_HOSTS: data.temporaryUdpHost ?? "",
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
    const file = join(generated, name ?? "");
    const udpPart = template === "pjsip.production.conf.base" && data.temporaryUdpHost !== undefined ? await readFile(join(root, "deploy/asterisk/pjsip.production.udp-temporario.part"), "utf8") : "";
    await writeFile(file, (source + udpPart).replace(/\$\{([A-Z_]+)\}/g, (original: string, key: string) => replacements[key] ?? original), { mode: 0o644 });
    await chmod(file, 0o644);
  }
  // O certificado é público. A chave privada só o Asterisk lê: 0600 com o dono do contêiner. Sem
  // poder trocar o dono (quem roda não é root nem o uid do Asterisk), fica 0644 para o TLS subir, e
  // o aviso diz o comando: nunca uma chave que o Asterisk não lê, que deixaria a central sem TLS.
  await writeFile(join(generated, "tls/server.crt"), certificate, { mode: 0o644 });
  await chmod(join(generated, "tls/server.crt"), 0o644);
  const keyFile = join(generated, "tls/server.key");
  await writeFile(keyFile, privateKey, { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const asteriskUid = options.asteriskUid ?? ASTERISK_UID;
  if (process.getuid?.() !== asteriskUid) {
    try {
      await chown(keyFile, asteriskUid, asteriskUid);
    } catch {
      await chmod(keyFile, 0o644);
      warnings.push(`A chave TLS ficou legível por outros usuários: rode sudo chown ${asteriskUid}:${asteriskUid} ${keyFile} && sudo chmod 600 ${keyFile}`);
    }
  }
  await chmod(generated, 0o700);
  await copyFile(join(root, "deploy/Caddyfile"), join(target, "Caddyfile"));
  const compose = parse(await readFile(join(root, "deploy/docker-compose.supabase.yml"), "utf8"), { merge: true }) as { services: Record<string, { build?: { context: string }; ports?: string[] }> };
  for (const service of Object.values(compose.services)) if (service.build) service.build.context = root;
  // TEMPORÁRIO: a 5060/udp só é publicada com a exceção pedida. Limite a origem no firewall do provedor.
  if (data.temporaryUdpHost !== undefined) compose.services.asterisk?.ports?.push("5060:5060/udp");
  await writeFile(join(target, "docker-compose.yml"), stringify(compose));
  return warnings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    const warnings = await prepareProduction(process.argv[2] ?? "", JSON.parse(Buffer.concat(chunks).toString()));
    process.stdout.write("Arquivos preparados. Nenhuma migration ou implantação executada.\n");
    for (const warning of warnings) process.stderr.write(`Aviso: ${warning}\n`);
  } catch {
    process.stderr.write("Preparo recusado. Confira diretório novo, URLs Supabase com TLS, conexão de sessão e certificado correspondente. Nenhum segredo foi impresso.\n");
    process.exitCode = 1;
  }
}
