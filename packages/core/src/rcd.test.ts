import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { callerDisplayNameSchema, convertRcdLogo, convertRcdLogoSet, effectiveRcd, MAX_RCD_BYTES, normalizeRcdName } from "./rcd";

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

it("normaliza o nome RCD: sem acento, em caixa alta, até 32 ASCII", () => {
  expect(normalizeRcdName("Clínica São João Ltda")).toBe("CLINICA SAO JOAO LTDA");
  expect(normalizeRcdName("  Ação   & Cia ")).toBe("ACAO & CIA");
  expect(normalizeRcdName("A".repeat(32))).toBe("A".repeat(32));
  for (const value of ["A".repeat(33), "", "   ", "日本", "x\n[endpoint]", "a;b"]) expect(normalizeRcdName(value)).toBeNull();
});
it("o valor próprio da linha vence o da empresa", () => {
  expect(effectiveRcd("LINHA", "EMPRESA")).toBe("LINHA");
  expect(effectiveRcd(null, "EMPRESA")).toBe("EMPRESA");
  expect(effectiveRcd(null, null)).toBeNull();
});
it("um logo de 1 MB sai em PNG e BMP 256x256 RGBA com até 300 KB cada", async () => {
  const input = execFileSync("python3", ["-E", "-c", 'from PIL import Image; import sys, os; Image.frombytes("RGBA", (512,512), os.urandom(512*512*4)).save(sys.stdout.buffer, format="PNG")'], { maxBuffer: 4 * 1024 * 1024 });
  expect(input.length).toBeGreaterThan(900 * 1024);
  const { png, bmp } = await convertRcdLogoSet(input);
  expect(png.length).toBeLessThanOrEqual(MAX_RCD_BYTES);
  expect(bmp.length).toBeLessThanOrEqual(MAX_RCD_BYTES);
  // BMP: assinatura, largura e altura (bottom-up), 32, compressão BI_BITFIELDS com máscara alfa bits por pixel.
  expect(bmp.subarray(0, 2).toString("latin1")).toBe("BM");
  expect(bmp.readInt32LE(18)).toBe(256);
  expect(bmp.readInt32LE(22)).toBe(256);
  expect(bmp.readUInt32LE(30)).toBe(3);
  expect(bmp.readUInt16LE(28)).toBe(32);
  const info = JSON.parse(execFileSync("python3", ["-E", "-c", 'from PIL import Image; import sys,json; im=Image.open(sys.stdin.buffer); print(json.dumps([list(im.size), im.mode]))'], { input: png }).toString());
  expect(info).toEqual([[256, 256], "RGBA"]);
  const bmpInfo = JSON.parse(execFileSync("python3", ["-E", "-c", 'from PIL import Image; import sys,json; im=Image.open(sys.stdin.buffer); print(json.dumps([im.format, list(im.size), im.mode]))'], { input: bmp }).toString());
  expect(bmpInfo).toEqual(["BMP", [256, 256], "RGBA"]);
});
it("o BMP guarda a transparência do original", async () => {
  const input = execFileSync("python3", ["-E", "-c", 'from PIL import Image; import sys; Image.new("RGBA", (400,100), (1,2,3,100)).save(sys.stdout.buffer, format="PNG")']);
  const { bmp } = await convertRcdLogoSet(input);
  const alpha = JSON.parse(execFileSync("python3", ["-E", "-c", 'from PIL import Image; import sys,json; im=Image.open(sys.stdin.buffer); print(json.dumps([im.getpixel((0,0))[3], im.getpixel((128,128))[3]]))'], { input: bmp }).toString());
  expect(alpha).toEqual([0, 100]);
});
