import { expect, it } from "vitest";
import { productionHealthcheck } from "./production-healthcheck";
it("HTTP 200 com fila parada ou banco falho reprova a checagem de produção", async () => {
  const fetcher = (worst: string) => (async () => Response.json({ ok: true, data: { worst, checks: [{ id: "routines", status: worst }] } })) as typeof fetch;
  expect(await productionHealthcheck("https://ozavo.example", fetcher("fail"))).toEqual({ exitCode: 2, lines: ["routines: fail"] });
  expect((await productionHealthcheck("https://ozavo.example", fetcher("ok"))).exitCode).toBe(0);
  expect((await productionHealthcheck("https://ozavo.example", fetcher("warn"))).exitCode).toBe(1);
});
