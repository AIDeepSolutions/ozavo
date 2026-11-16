import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const report = z.object({ ok: z.literal(true), data: z.object({ worst: z.enum(["ok", "warn", "fail"]),
  checks: z.array(z.object({ id: z.string(), status: z.enum(["ok", "warn", "fail"]) })) }) });
/** HTTP 200 não basta: mede o relatório de banco, voz, telefonia e consumidor da fila. */
export async function productionHealthcheck(url: string, request: typeof fetch = fetch): Promise<{ exitCode: number; lines: string[] }> {
  const target = new URL("/api/v1/system/health", z.url().parse(url));
  const response = await request(target, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!response.ok) throw new Error("Health endpoint did not answer successfully");
  const parsed = report.parse(await response.json());
  return { exitCode: parsed.data.worst === "fail" ? 2 : parsed.data.worst === "warn" ? 1 : 0,
    lines: parsed.data.checks.map(check => `${check.id}: ${check.status}`) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await productionHealthcheck(process.argv[2] ?? "");
    process.stdout.write(result.lines.join("\n") + "\n");
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write("Não foi possível conferir a saúde da instalação.\n"); process.exitCode = 2;
  }
}
