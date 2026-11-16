import { execFile } from "node:child_process";
import { z } from "zod";

/** ASCII seguro no dialplan e no arquivo PJSIP; nunca trunca silenciosamente a identidade. */
export const callerDisplayNameSchema = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9 .&()+_\/-]+$/);
export const MAX_RCD_BYTES = 300 * 1024;
const CONVERTER = `
import sys, io, warnings
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
    data = output.getvalue()
    if len(data) > 300 * 1024: raise ValueError("output too large")
    sys.stdout.buffer.write(data)
`;

/** Pillow: PNG RGBA 256×256, sem metadados, mantendo proporção e transparência. */
export async function convertRcdLogo(input: Buffer): Promise<Buffer> {
  if (input.length === 0 || input.length > 8 * 1024 * 1024) throw new Error("Invalid RCD input size");
  return new Promise((resolve, reject) => {
    const child = execFile("python3", ["-E", "-c", CONVERTER], { encoding: "buffer", maxBuffer: MAX_RCD_BYTES, timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(new Error("RCD image conversion failed"));
      resolve(stdout);
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(input);
  });
}
