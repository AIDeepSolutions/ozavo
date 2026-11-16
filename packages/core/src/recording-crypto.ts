import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { open, rename, rm, utimes } from "node:fs/promises";
import { Readable } from "node:stream";
import { basename, dirname } from "node:path";

const MAGIC = Buffer.from("OZREC001");
const END = 0xffffffff;

/** Cada escrita é autenticada com arquivo, posição e sequência; nenhum PCM vai ao disco. */
export function recordingEncryptor(key: Buffer) {
  if (key.length !== 32) throw new Error("Recording key must have 32 bytes");
  const id = randomBytes(16);
  let sequence = 0;
  function frame(data: Buffer, offset: number): Buffer {
    const meta = Buffer.alloc(12);
    meta.writeUInt32BE(data.length, 0);
    meta.writeUInt32BE(offset, 4);
    meta.writeUInt32BE(sequence++, 8);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.concat([MAGIC, id, meta]));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([meta, nonce, cipher.getAuthTag(), encrypted]);
  }
  return {
    header: Buffer.concat([MAGIC, id]),
    frame,
    end: (bytes: number) => {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(bytes);
      return frame(size, END);
    },
  };
}

/** Legado WAV continua legível; arquivos novos exigem autenticação completa, inclusive o fim. */
export function decryptRecording(encoded: Buffer, key: Buffer): Buffer {
  if (encoded.subarray(0, 4).toString() === "RIFF") return encoded;
  if (!encoded.subarray(0, 8).equals(MAGIC) || key.length !== 32) throw new Error("Unknown recording format or key");
  const id = encoded.subarray(8, 24);
  let at = 24;
  let sequence = 0;
  let length = 0;
  let ended = false;
  const writes: Array<{ offset: number; data: Buffer }> = [];
  while (at < encoded.length) {
    if (ended || at + 40 > encoded.length) throw new Error("Invalid recording frame");
    const meta = encoded.subarray(at, at + 12);
    const size = meta.readUInt32BE(0);
    const offset = meta.readUInt32BE(4);
    if (meta.readUInt32BE(8) !== sequence++ || size > encoded.length - at - 40) throw new Error("Invalid recording sequence or size");
    const decipher = createDecipheriv("aes-256-gcm", key, encoded.subarray(at + 12, at + 24));
    decipher.setAAD(Buffer.concat([MAGIC, id, meta]));
    decipher.setAuthTag(encoded.subarray(at + 24, at + 40));
    const data = Buffer.concat([decipher.update(encoded.subarray(at + 40, at + 40 + size)), decipher.final()]);
    if (offset === END) {
      if (data.length !== 4 || data.readUInt32BE() !== length) throw new Error("Invalid recording end");
      ended = true;
    } else {
      // Positional writes may replace the WAV header, but may never leave gaps.
      if (offset > length || offset + size > END) throw new Error("Invalid recording offset");
      writes.push({ offset, data });
      length = Math.max(length, offset + size);
    }
    at += 40 + size;
  }
  if (!ended) throw new Error("Incomplete encrypted recording");
  const plain = Buffer.alloc(length);
  for (const write of writes) write.data.copy(plain, write.offset);
  return plain;
}

/** Vincula o cifrado à organização/chamada e separa a chave dos segredos de configuração. */
export function recordingKey(file: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("Recording key must have 32 bytes");
  return createHmac("sha256", key).update(`ozavo-recording-v1:${basename(dirname(file))}/${basename(file)}`).digest();
}

/** Leitura em fluxo: só um bloco cifrado e seu claro ficam na memória. */
export async function openRecordingAudio(file: string, masterKey: Buffer): Promise<{ size: number; stream: Readable; close(): Promise<void> }> {
  const handle = await open(file);
  const read = async (at: number, size: number): Promise<Buffer> => {
    const buffer = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const result = await handle.read(buffer, got, size - got, at + got);
      if (result.bytesRead === 0) throw new Error("Incomplete recording");
      got += result.bytesRead;
    }
    return buffer;
  };
  try {
    const { size: encodedSize } = await handle.stat();
    const header = await read(0, Math.min(24, encodedSize));
    if (header.subarray(0, 4).toString() === "RIFF") return { size: encodedSize, stream: handle.createReadStream(), close: () => handle.close() };
    if (!header.subarray(0, 8).equals(MAGIC) || encodedSize < 24 + 84 + 84 + 44) throw new Error("Unknown recording format");
    const key = recordingKey(file, masterKey);
    const decode = (frame: Buffer): Buffer => {
      const meta = frame.subarray(0, 12);
      if (meta.readUInt32BE() !== frame.length - 40) throw new Error("Invalid recording frame size");
      const decipher = createDecipheriv("aes-256-gcm", key, frame.subarray(12, 24));
      decipher.setAAD(Buffer.concat([MAGIC, header.subarray(8, 24), meta]));
      decipher.setAuthTag(frame.subarray(24, 40));
      return Buffer.concat([decipher.update(frame.subarray(40)), decipher.final()]);
    };
    const lastHeaderAt = encodedSize - 128;
    const lastHeader = await read(lastHeaderAt, 84);
    const footer = await read(encodedSize - 44, 44);
    const size = decode(footer).readUInt32BE();
    const wav = decode(lastHeader);
    if (lastHeader.readUInt32BE(4) !== 0 || footer.readUInt32BE(4) !== END || footer.readUInt32BE(8) !== lastHeader.readUInt32BE(8) + 1 || wav.readUInt32LE(40) + 44 !== size) throw new Error("Invalid recording footer");
    async function* chunks() {
      let at = 24;
      let position = 0;
      let sequence = 0;
      try {
        yield wav;
        while (at < lastHeaderAt) {
          const meta = await read(at, 12);
          const count = meta.readUInt32BE();
          if (count > lastHeaderAt - at - 40 || meta.readUInt32BE(4) !== position || meta.readUInt32BE(8) !== sequence++) throw new Error("Invalid recording sequence");
          const plain = decode(await read(at, 40 + count));
          if (position > 0) yield plain; // O cabeçalho provisório é substituído pelo final.
          else if (count !== 44) throw new Error("Invalid WAV header");
          position += count;
          at += 40 + count;
        }
        if (position !== size || sequence !== lastHeader.readUInt32BE(8)) throw new Error("Incomplete recording");
      } finally { await handle.close(); }
    }
    const stream = Readable.from(chunks());
    stream.once("close", () => { void handle.close(); });
    return { size, stream, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readRecording(file: string, key: Buffer): Promise<Buffer> {
  const audio = await openRecordingAudio(file, key);
  const chunks: Buffer[] = [];
  for await (const chunk of audio.stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** Atualização progressiva de WAV legado, sem claro temporário nem carregar a chamada inteira. */
export async function sealLegacyRecording(file: string, key: Buffer): Promise<void> {
  const input = await open(file);
  const temporary = `${file}.${randomUUID()}.encrypting`;
  try {
    const header = Buffer.alloc(44);
    const first = await input.read(header, 0, 44, 0);
    if (header.subarray(0, 8).equals(MAGIC)) return;
    if (first.bytesRead !== 44 || header.toString("ascii", 0, 4) !== "RIFF") throw new Error("Invalid legacy WAV");
    const info = await input.stat();
    const encryption = recordingEncryptor(recordingKey(file, key));
    const output = await open(temporary, "wx", 0o600);
    try {
      const write = async (data: Buffer) => {
        for (let at = 0; at < data.length;) {
          const result = await output.write(data, at, data.length - at);
          if (result.bytesWritten === 0) throw new Error("Recording encryption write made no progress");
          at += result.bytesWritten;
        }
      };
      await write(encryption.header);
      await write(encryption.frame(header, 0));
      let position = 44;
      for await (const chunk of input.createReadStream({ start: 44, autoClose: false })) {
        const data = Buffer.from(chunk as Uint8Array);
        await write(encryption.frame(data, position));
        position += data.length;
      }
      await write(encryption.frame(header, 0));
      await write(encryption.end(position));
      await output.sync();
    } finally { await output.close(); }
    await utimes(temporary, info.atime, info.mtime);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally { await input.close(); }
}
