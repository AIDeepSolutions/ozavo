// dono: @DeskLabs-OpenSource/maintainers
// motivo: a documentação e um script citavam a pasta de credenciais e a pasta de trabalho da VPS
//   de quem mantém o projeto. Num repositório aberto isso é informação de operação de uma pessoa,
//   não do produto, e quem instala não tem esses caminhos (auditoria A21).
// revisar em: 2027-05-16
import { describe, it, expect } from "vitest";
import { REPO_ROOT, expectClean, fixture, listFiles, read } from "./_lib";

// Montados por partes para esta cerca não reprovar a si mesma.
const PRIVATE = [[".config", "dev-hub"].join("/"), ["", "home", "dev", ""].join("/"), ["agent", "state/"].join("-")];
// `.git` de um worktree é um arquivo que aponta para o clone principal: é da máquina, não do repositório.
const isText = (file: string): boolean => file !== ".git" && !/\.(png|jpe?g|gif|ico|webp|woff2?|ulaw|wav|gz|zip|pdf|svg)$/i.test(file);

function check(root: string): string[] {
  const violations: string[] = [];
  for (const file of listFiles(root, ".", isText)) {
    const lines = read(root, file).split("\n");
    lines.forEach((line, index) => {
      for (const marker of PRIVATE) if (line.includes(marker)) violations.push(`${file}:${index + 1}: cita \`${marker}\``);
    });
  }
  return violations;
}

describe("no-private-paths", () => {
  it("nenhum arquivo cita caminhos da máquina de quem mantém o projeto", () => {
    expectClean(check(REPO_ROOT), "Troque o caminho por uma variável de ambiente genérica (CARTESIA_API_KEY, OPENROUTER_API_KEY) ou por um caminho relativo ao repositório.");
  });

  it("reprova pasta de credenciais, home e pasta de estado do agente, e aceita variável de ambiente", () => {
    expect(check(fixture("no-private-paths"))).toEqual(PRIVATE.map((marker, index) => `docs/guia.md:${index + 1}: cita \`${marker}\``));
  });
});
