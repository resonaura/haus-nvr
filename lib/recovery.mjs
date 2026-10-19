import { createDecipheriv, randomUUID } from "node:crypto";
import { open, link, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
export async function decryptBackup(input, output, key) {
  const fd = await open(input, "r");
  let header, tag, size, offset;
  try {
    size = (await fd.stat()).size;
    const prefix = Buffer.alloc(4);
    await fd.read(prefix, 0, 4, 0);
    const length = prefix.readUInt32BE();
    if (length < 1 || length > 16384 || size < length + 20)
      throw new Error("Invalid backup");
    header = Buffer.alloc(length);
    await fd.read(header, 0, length, 4);
    offset = length + 4;
    tag = Buffer.alloc(16);
    await fd.read(tag, 0, 16, size - 16);
  } finally {
    await fd.close();
  }
  const metadata = JSON.parse(header);
  if (
    metadata.version !== 1 ||
    !/^[a-f0-9]{24}$/.test(metadata.iv) ||
    !/^[a-f0-9]{64}$/.test(key)
  )
    throw new Error("Invalid recovery key or backup version");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    Buffer.from(metadata.iv, "hex"),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const temporary = output + ".unverified-" + randomUUID();
  try {
    await pipeline(
      createReadStream(input, { start: offset, end: size - 17 }),
      decipher,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    // Never overwrite an existing archive, and never extract/apply a backup automatically.
    await link(temporary, output);
    return metadata;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
