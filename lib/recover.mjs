import {
  readFile,
  mkdtemp,
  rm,
  copyFile,
  link,
  unlink,
} from "node:fs/promises";
import { createWriteStream, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sign } from "./auth.mjs";
import { decryptBackup } from "./recovery.mjs";
const args = process.argv.slice(2),
  option = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--kit") || !args.includes("--node"))
  throw new Error(
    "Use --kit haus-recovery.json --node NODE_ID --list, or --digest SHA256 --output ARCHIVE.tar",
  );
const kit = JSON.parse(await readFile(resolve(option("--kit")), "utf8")),
  node = kit.nodes.find((node) => node.id === option("--node"));
if (!node) throw new Error("Node is not in this recovery kit");
const base = new URL(node.url);
if (
  !["http:", "https:"].includes(base.protocol) ||
  base.username ||
  base.password ||
  (base.protocol === "http:" && !node.allowHttp)
)
  throw new Error("Untrusted node address");
const request = async (path) => {
  const response = await fetch(new URL(path, base), {
    headers: sign(node.key, "GET", path),
    redirect: "error",
    signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw new Error(`Node returned ${response.status}`);
  return response;
};
if (args.includes("--list-recordings"))
  console.log(
    JSON.stringify(
      await (
        await request(
          "/v1/recordings" +
            (args.includes("--cursor")
              ? "?cursor=" + encodeURIComponent(option("--cursor"))
              : ""),
        )
      ).json(),
      null,
      2,
    ),
  );
else if (args.includes("--list"))
  console.log(
    JSON.stringify(await (await request("/v1/backups")).json(), null, 2),
  );
else {
  if (
    (!args.includes("--digest") && !args.includes("--recording")) ||
    !args.includes("--output") ||
    (args.includes("--digest") && !/^[a-f0-9]{64}$/.test(option("--digest")))
  )
    throw new Error("Choose a backup digest and output file");
  const video = args.includes("--recording");
  let digest = option("--digest");
  if (video) {
    const id = option("--recording");
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid recording id");
    digest = (await (await request("/v1/recordings/" + id)).json()).digest;
  }
  const directory = await mkdtemp(join(tmpdir(), "haus-recovery-"));
  try {
    const path = "/v1/blobs/" + digest,
      response = await request(path),
      hash = createHash("sha256");
    let bytes = 0;
    const file = join(directory, "backup.enc");
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, encoding, cb) {
          bytes += chunk.length;
          if (bytes > 20 * 1024 ** 3)
            return cb(new Error("Backup exceeds recovery budget"));
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
    );
    if (hash.digest("hex") !== digest)
      throw new Error("Backup checksum mismatch");
    if (video) {
      const output = resolve(option("--output")),
        temporary = output + ".verified-" + randomUUID();
      try {
        await copyFile(file, temporary, constants.COPYFILE_EXCL);
        await link(temporary, output);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      console.log(
        "Verified recording exported. No home configuration was changed.",
      );
    } else {
      const metadata = await decryptBackup(
        file,
        resolve(option("--output")),
        kit.key,
      );
      console.log(
        `Verified ${metadata.kind === "ha" ? "Home Assistant" : "Haus"} backup exported. No system configuration was changed.`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
