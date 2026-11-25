import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentKnowledge, getKnowledgeSource, listKnowledgeSources, withOrg, withSystem } from "@ozavo/core";
import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs, t0 } from "../../test/helpers";
import { importKnowledge } from "./import-knowledge";

const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const makeAgent = async (org: string): Promise<string> =>
  (await withSystem(app, (q) => q.one<{ id: string }>("insert into agents (organization_id, name, engine, knowledge_mode, knowledge_only) values ($1, 'A', 'simulated', 'rag', true) returning id", [org])))?.id ?? "";

describe("import-knowledge", () => {
  it("cria a base, liga ao agente sem mexer no modo e, na segunda vez, troca o conteúdo em vez de duplicar", async () => {
    const org = await createOrganization(app, "import kb");
    const agent = await makeAgent(org);
    const dir = await mkdtemp(join(tmpdir(), "kb-import-"));
    const file = join(dir, "faq.md");
    await writeFile(file, "# Horários\n\nAtendemos de segunda a sexta.");
    const first = await importKnowledge(app, { organizationId: org, name: "FAQ", file, agentIds: [agent] }, t0);
    expect(first).toMatchObject({ replaced: false, linkedAgents: [agent] });
    expect(await withOrg(app, org, (q) => getAgentKnowledge(q, agent))).toMatchObject({ mode: "rag", only: true, linkedIds: [first.sourceId] });

    await writeFile(file, "# Horários\n\nAtendemos de segunda a sábado.");
    const second = await importKnowledge(app, { organizationId: org, name: "FAQ", file, agentIds: [agent] }, t0);
    expect(second).toMatchObject({ replaced: true, sourceId: first.sourceId });
    expect(await withOrg(app, org, (q) => listKnowledgeSources(q))).toHaveLength(1);
    expect((await withOrg(app, org, (q) => getKnowledgeSource(q, first.sourceId)))?.latestVersion).toBe(2);
  });

  it("recusa tipo de arquivo desconhecido e agente de outra empresa", async () => {
    const org = await createOrganization(app, "import kb refuse");
    const other = await createOrganization(app, "import kb other");
    const otherAgent = await makeAgent(other);
    const dir = await mkdtemp(join(tmpdir(), "kb-import-"));
    const exe = join(dir, "x.exe");
    await writeFile(exe, "x");
    await expect(importKnowledge(app, { organizationId: org, name: "X", file: exe }, t0)).rejects.toThrow(/tipo de arquivo não aceito/);
    const md = join(dir, "a.md");
    await writeFile(md, "texto");
    await expect(importKnowledge(app, { organizationId: org, name: "A", file: md, agentIds: [otherAgent] }, t0)).rejects.toThrow(/não existe nesta empresa/);
  });
});
