import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWindowsDisks, windowsDisks } from "../lib/windows-disks.mjs";

const fixture = () => ({
  Disks: [
    {
      Index: 0,
      Model: "HFM256GDJTNI-82A0A",
      Size: 256052966400,
      Partitions: [
        { Index: 0, Size: 104857600, Volumes: [] },
        {
          Index: 1,
          Size: 254863736832,
          Volumes: [
            {
              DeviceID: "C:",
              VolumeName: "Acer",
              FileSystem: "NTFS",
              Size: 254863732736,
              FreeSpace: 62850797568,
            },
          ],
        },
      ],
    },
  ],
});

test("native Windows storage reports the physical disk and its actual partition/volume usage", () => {
  const disks = parseWindowsDisks(fixture());
  assert.deepEqual(
    disks.map((disk) => disk.type),
    ["disk", "partition", "partition", "volume"],
  );
  assert.equal(disks[0].physical, true);
  assert.equal(disks[0].totalBytes, 256052966400);
  assert.equal(disks[0].usedBytes, null);
  assert.equal(disks[3].parentId, disks[2].id);
  assert.equal(disks[3].mountpoint, "C:\\");
  assert.equal(disks[3].usedBytes, 192012935168);
  assert.equal(disks[3].availableBytes, 62850797568);
});

test("spanned volumes keep all partition parents without duplicating capacity", () => {
  const value = fixture();
  value.Disks.push({ ...value.Disks[0], Index: 1 });
  const disks = parseWindowsDisks(value),
    volume = disks.find((disk) => disk.type === "volume");
  assert.equal(disks.filter((disk) => disk.type === "volume").length, 1);
  assert.deepEqual(volume.parentIds, [
    "windows-disk:0:partition:1",
    "windows-disk:1:partition:1",
  ]);
});

test("virtual/unknown devices do not become physical and missing use never becomes zero", () => {
  const value = fixture();
  value.Disks[0].Model = "Msft Virtual Disk";
  value.Disks[0].Partitions[1].Volumes[0].FreeSpace = null;
  value.Disks.push({ Index: 1, Size: null });
  const disks = parseWindowsDisks(value);
  assert.equal(disks[0].physical, false);
  assert.equal(disks.find((disk) => disk.type === "volume").usedBytes, null);
  assert.equal(disks.at(-1).physical, null);
  assert.equal(disks.at(-1).totalBytes, null);
  assert.deepEqual(
    parseWindowsDisks({ Disks: [{ Index: null }, { Index: -1 }] }),
    [],
  );
});

test("CIM executes bounded fixed selectors through WSL interoperability and rejects empty output", async () => {
  const commands = [];
  const disks = await windowsDisks({
    wsl: true,
    run: async (file, args, options) => {
      commands.push({ file, args, options });
      return "\uFEFF" + JSON.stringify(fixture());
    },
  });
  assert.equal(disks.length, 4);
  assert.equal(
    commands[0].file,
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  assert.equal(commands[0].options.timeout, 8000);
  const script = Buffer.from(commands[0].args.at(-1), "base64").toString(
    "utf16le",
  );
  assert.match(script, /Win32_DiskDriveToDiskPartition/);
  assert.match(script, /Win32_LogicalDiskToPartition/);
  assert.doesNotMatch(script, /SerialNumber|Set-|Remove-|Invoke-|Format-/);
  await assert.rejects(
    windowsDisks({ run: async () => "{}" }),
    /windows_disks_unavailable/,
  );
});
