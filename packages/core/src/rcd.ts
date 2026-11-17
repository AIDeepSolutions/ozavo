import { execFile } from "node:child_process";
import { z } from "zod";

/** ASCII seguro no dialplan e no arquivo PJSIP; nunca trunca silenciosamente a identidade. */
export const callerDisplayNameSchema = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9 .&()+_\/-]+$/);
export const MAX_RCD_BYTES = 300 * 1024;
const CONVERTER = `
import sys, io, struct, warnings
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 4000000
warnings.simplefilter("error", Image.DecompressionBombWarning)
raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
if len(raw) > 8 * 1024 * 1024: raise ValueError("image too large")
with Image.open(io.BytesIO(raw)) as image:
    if image.format not in ("PNG", "JPEG", "BMP") or getattr(image, "n_frames", 1) != 1:
        raise ValueError("unsupported image")
    image.load()
    icon = ImageOps.contain(ImageOps.exif_transpose(image).convert("RGBA"), (256, 256), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    canvas.alpha_composite(icon, ((256-icon.width)//2, (256-icon.height)//2))
    output = io.BytesIO()
    canvas.save(output, format="PNG", optimize=True)
    png = output.getvalue()
    if len(png) > 300 * 1024:
        output = io.BytesIO()
        canvas.quantize(256, method=Image.Quantize.FASTOCTREE).save(output, format="PNG", optimize=True)
        png = output.getvalue()
    # BMP de 32 bits com cabeçalho V4 e máscaras: é o que carrega o canal alfa de forma legível.
    pixels = canvas.tobytes("raw", "BGRA", 0, -1)
    header = struct.pack("<2sIHHI", b"BM", 122 + len(pixels), 0, 0, 122)
    info = struct.pack("<IiiHHIIiiII", 108, 256, 256, 1, 32, 3, len(pixels), 2835, 2835, 0, 0)
    info += struct.pack("<IIII", 0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000) + struct.pack("<I", 0x57696E20) + bytes(48)
    bmp = header + info + pixels
    if len(png) > 300 * 1024 or len(bmp) > 300 * 1024: raise ValueError("output too large")
    sys.stdout.buffer.write(len(png).to_bytes(4, "big") + png + bmp)
`;

/** Os dois formatos que a operadora pode pedir: PNG RGBA e BMP de 32 bits com alfa, ambos 256×256. */
export interface RcdLogoSet {
  png: Buffer;
  bmp: Buffer;
}

/** Pillow: PNG e BMP RGBA 256×256, sem metadados, mantendo proporção e transparência, até 300 KB cada. */
export async function convertRcdLogoSet(input: Buffer): Promise<RcdLogoSet> {
  if (input.length === 0 || input.length > 8 * 1024 * 1024) throw new Error("Invalid RCD input size");
  const framed = await new Promise<Buffer>((resolve, reject) => {
    const child = execFile("python3", ["-E", "-c", CONVERTER], { encoding: "buffer", maxBuffer: 2 * MAX_RCD_BYTES + 16, timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(new Error("RCD image conversion failed"));
      resolve(stdout);
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(input);
  });
  const pngLength = framed.length >= 4 ? framed.readUInt32BE(0) : 0;
  if (pngLength === 0 || 4 + pngLength >= framed.length) throw new Error("RCD image conversion failed");
  return { png: framed.subarray(4, 4 + pngLength), bmp: framed.subarray(4 + pngLength) };
}

/** Só o PNG, para a linha. */
export async function convertRcdLogo(input: Buffer): Promise<Buffer> {
  return (await convertRcdLogoSet(input)).png;
}

/**
 * Nome RCD do cadastro: tira acento e cedilha, passa para CAIXA ALTA, junta espaços repetidos e só
 * devolve se couber em ASCII seguro com até 32 caracteres. `null` quando não serve (nunca trunca).
 */
export function normalizeRcdName(input: string): string | null {
  const name = input.normalize("NFD").replace(/\p{M}+/gu, "").toLocaleUpperCase("en-US").replace(/\s+/g, " ").trim();
  return callerDisplayNameSchema.safeParse(name).success ? name : null;
}

/** A identidade que a linha apresenta: o valor próprio vence; sem ele vale o da empresa. */
export function effectiveRcd<T>(line: T | null | undefined, company: T | null | undefined): T | null {
  return line ?? company ?? null;
}
