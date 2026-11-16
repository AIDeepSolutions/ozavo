import { expect, it } from "vitest";
import { recordingRetentionOf, recordingRetentionSchema } from "./recording-retention";
it("gravação tem piso e padrão de 90 dias, nunca infinito nem prazo menor por valor inválido", () => {
  for (const value of [undefined, null, 0, 30, "90", {}, -1, 4000]) expect(recordingRetentionOf(value)).toBe(90);
  expect(recordingRetentionOf(180)).toBe(180);
  expect(recordingRetentionSchema.safeParse(89).success).toBe(false);
  expect(recordingRetentionSchema.safeParse(90).success).toBe(true);
});
