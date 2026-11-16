import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { callerDisplayNameSchema, convertRcdLogo, MAX_RCD_BYTES } from "./rcd";

it("valida nome ASCII sem truncar nem aceitar injeção na configuração", () => {
  expect(callerDisplayNameSchema.parse("OZAVO - AI DEEP SOLUTIONS")).toBe("OZAVO - AI DEEP SOLUTIONS");
  expect(callerDisplayNameSchema.safeParse("A".repeat(32)).success).toBe(true);
  for (const value of ["A".repeat(33), "Ozavó", "Ação", "x\n[endpoint]", "name;set_var=x", ""]) expect(callerDisplayNameSchema.safeParse(value).success).toBe(false);
});
it("Pillow produz PNG RGBA 256x256 <=300KB, sem esticar a imagem", async () => {
  const input = execFileSync("python3", ["-E", "-c", 'from PIL import Image; import sys; Image.new("RGBA", (500,100), (1,2,3,128)).save(sys.stdout.buffer, format="PNG")']);
  const output = await convertRcdLogo(input);
  expect(output.length).toBeLessThanOrEqual(MAX_RCD_BYTES);
  const info = JSON.parse(execFileSync("python3", ["-E", "-c", 'from PIL import Image; import sys,json; im=Image.open(sys.stdin.buffer); print(json.dumps([list(im.size), im.mode, im.getpixel((0,0))[3], im.getpixel((128,128))[3]]))'], { input: output }).toString());
  expect(info).toEqual([[256,256], "RGBA", 0, 128]);
  await expect(convertRcdLogo(Buffer.from("not an image"))).rejects.toThrow();
  await expect(convertRcdLogo(Buffer.alloc(8 * 1024 * 1024 + 1))).rejects.toThrow();
});
