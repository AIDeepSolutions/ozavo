import { describe, expect, it } from "vitest";
import en from "./en/common";
import es from "./es/common";
import ptBR from "./pt-BR/common";

// O manual da marca fixa a assinatura em português, em qualquer idioma (brand/README.md).
describe("assinatura da marca", () => {
  it("é a mesma frase, sem tradução, nos três idiomas", () => {
    const signatures = [ptBR, en, es].map((dictionary) => dictionary.shell.signature);
    expect(signatures).toEqual(["Ozavo — Uma solução AI Deep Solutions", "Ozavo — Uma solução AI Deep Solutions", "Ozavo — Uma solução AI Deep Solutions"]);
  });
});
