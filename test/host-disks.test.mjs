import { test } from "node:test";
import assert from "node:assert/strict";
import { linuxDisks, macDisks } from "../lib/host-platform.mjs";
import { HostTelemetry, sanitizeHostReport } from "../lib/host-telemetry.mjs";

const filesystem = async () => ({
  blocks: 1000,
  bsize: 1,
  bfree: 400,
  bavail: 350,
});
const collect = (blockdevices, options = {}) =>
  linuxDisks({
    run: async () => JSON.stringify({ blockdevices }),
    filesystem,
    ...options,
  });

test("Linux storage layers preserve disk/partition/encryption/LVM parents without counting them as physical disks", async () => {
  const disks = await collect([
    {
      name: "nvme0n1",
      type: "disk",
      size: 2000,
      tran: "nvme",
      children: [
        {
          name: "nvme0n1p3",
          type: "part",
          size: 1800,
          children: [
            {
              name: "cryptroot",
              type: "crypt",
              size: 1799,
              children: [
                {
                  name: "vg-root",
                  type: "lvm",
                  size: 1600,
                  fstype: "ext4",
                  mountpoints: ["/", "/export/Home"],
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(
    disks.map((disk) => disk.type),
    ["disk", "partition", "container", "container", "volume", "volume"],
  );
  assert.equal(disks.filter((disk) => disk.kind === "disk").length, 1);
  assert.equal(disks.filter((disk) => disk.physical === true).length, 1);
  assert.deepEqual(
    disks.map((disk) => disk.parentId),
    [
      null,
      "block:nvme0n1",
      "block:nvme0n1p3",
      "block:cryptroot",
      "block:vg-root",
      "block:vg-root",
    ],
  );
  assert.equal(disks[4].mountpoint, "/");
  assert.equal(disks[4].availableBytes, 350);
  assert.equal(disks[1].usedBytes, null);
});

test("shared RAID/multipath layers keep all physical parents and a stable primary without duplicate rows", async () => {
  const raid = {
    name: "md0",
    type: "raid1",
    size: 1000,
    children: [
      {
        name: "crypt-media",
        type: "crypt",
        size: 999,
        fstype: "ext4",
        mountpoints: ["/media"],
      },
    ],
  };
  const disks = await collect([
    { name: "sda", type: "disk", size: 1000, tran: "sata", children: [raid] },
    { name: "sdb", type: "disk", size: 1000, tran: "usb", children: [raid] },
    {
      name: "sdz",
      type: "disk",
      size: 1000,
      tran: "fc",
      children: [{ name: "mpatha", type: "mpath", size: 1000 }],
    },
  ]);
  assert.equal(new Set(disks.map((disk) => disk.id)).size, disks.length);
  const mapped = disks.find((disk) => disk.id === "block:md0");
  assert.equal(mapped.type, "container");
  assert.equal(mapped.kind, "volume");
  assert.equal(mapped.physical, false);
  assert.equal(mapped.parentId, "block:sda");
  assert.deepEqual(mapped.parentIds, ["block:sda", "block:sdb"]);
  assert.equal(
    disks.find((disk) => disk.id === "block:mpatha").type,
    "container",
  );
  assert.equal(disks.filter((disk) => disk.kind === "disk").length, 3);
});

test("unknown and virtual block devices do not claim physical hardware; WSL stays virtual", async () => {
  const blockdevices = [
    { name: "sda", type: "disk", size: 1000 },
    {
      name: "vda",
      type: "disk",
      size: 1000,
      subsystems: "block:virtio:pci",
      tran: "scsi",
    },
    {
      name: "sdb",
      type: "disk",
      size: 1000,
      model: "VMware Virtual disk",
      tran: "scsi",
    },
    { name: "mystery", type: "unknown", size: 1000 },
    { name: "loop0", type: "loop", size: 1000 },
    { name: "sr0", type: "rom", size: 1000 },
  ];
  const disks = await collect(blockdevices);
  assert.deepEqual(
    disks.map((disk) => disk.physical),
    [null, false, false, false],
  );
  assert.equal(disks.at(-1).type, "container");
  const wsl = await collect(
    [{ name: "sdc", type: "disk", tran: "scsi", size: 1000 }],
    { virtualized: true },
  );
  assert.equal(wsl[0].physical, false);
});

test("fallback mount inventory remains volumes and never invents physical parents", async () => {
  const disks = await linuxDisks({
    run: async () => {
      throw new Error("missing lsblk");
    },
    read: async () =>
      "/dev/mapper/root / ext4 rw 0 0\nserver:/media /mnt/media nfs4 rw 0 0\nproc /proc proc rw 0 0\n",
    filesystem,
  });
  assert.equal(disks.length, 2);
  assert.ok(
    disks.every(
      (disk) =>
        disk.type === "volume" &&
        disk.physical === false &&
        disk.parentId === null,
    ),
  );
  assert.ok(disks.every((disk) => disk.parentIds.length === 0));
});

test("macOS APFS container and volumes remain attached through the physical partition", async () => {
  const rows = [
    {
      DeviceIdentifier: "disk0",
      Size: 2000,
      OSInternal: true,
      Content: "GUID_partition_scheme",
      Partitions: [
        { DeviceIdentifier: "disk0s2", Size: 1800, Content: "Apple_APFS" },
      ],
    },
    {
      DeviceIdentifier: "disk3",
      Size: 1800,
      Content: "Apple_APFS_Container",
      APFSPhysicalStores: [{ DeviceIdentifier: "disk0s2" }],
      APFSVolumes: [
        {
          DeviceIdentifier: "disk3s1",
          Size: 1800,
          VolumeName: "Data",
          CapacityInUse: 600,
          MountPoint: "/System/Volumes/Data",
        },
      ],
    },
  ];
  const disks = await macDisks({
    run: async (file) =>
      file.endsWith("diskutil")
        ? "<plist/>"
        : JSON.stringify({ AllDisksAndPartitions: rows }),
    filesystem,
  });
  assert.deepEqual(
    disks.map((disk) => disk.type),
    ["disk", "partition", "container", "volume"],
  );
  assert.equal(disks.filter((disk) => disk.kind === "disk").length, 1);
  assert.equal(
    disks.find((disk) => disk.id === "disk:disk3").parentId,
    "disk:disk0s2",
  );
  assert.equal(disks.at(-1).parentId, "disk:disk3");
  assert.equal(disks.at(-1).usedBytes, 600);
});

test("collector sanitizer keeps additive metadata, accepts legacy reports and removes invalid parents", () => {
  const report = {
    sampledAt: new Date().toISOString(),
    scope: "host",
    cpu: { logicalCores: 4 },
    memory: { totalBytes: 100, availableBytes: 50, usedBytes: 50 },
    disks: [
      { id: "disk", kind: "disk", totalBytes: 100 },
      {
        id: "mapped",
        kind: "volume",
        type: "container",
        physical: false,
        parentId: "disk",
        parentIds: ["disk", "mapped", 22],
      },
      {
        id: "unrecognized",
        kind: "volume",
        type: "execute",
        physical: "yes",
        totalBytes: 100,
      },
    ],
  };
  report.disks[1].totalBytes = 100;
  const result = sanitizeHostReport(report);
  assert.equal(result.disks[0].type, "disk");
  assert.equal(result.disks[0].physical, null);
  assert.equal(result.disks[1].type, "container");
  assert.deepEqual(result.disks[1].parentIds, ["disk"]);
  assert.equal(result.disks[2].type, "volume");
  assert.equal(result.disks[2].physical, null);
});

test("WSL release does not become Windows native telemetry or physical host disk data", async () => {
  const commands = [];
  const system = {
    cpus: () => [{ model: "CPU", times: { user: 1, idle: 9 } }],
    totalmem: () => 1000,
    freemem: () => 500,
    release: () => "6.6.87.2-microsoft-standard-WSL2",
    hostname: () => "host",
    arch: () => "x64",
    uptime: () => 100,
    loadavg: () => [0, 0, 0],
  };
  const telemetry = new HostTelemetry({
    platform: "linux",
    container: false,
    system,
    read: async () => "",
    run: async (file) => {
      commands.push(file);
      return JSON.stringify({
        blockdevices: [{ name: "sda", type: "disk", size: 1000, tran: "scsi" }],
      });
    },
  });
  await telemetry.initialize({ poll: false });
  assert.equal(telemetry.status().platform, "linux");
  assert.match(telemetry.status().release, /WSL2/);
  assert.equal(telemetry.status().disks[0].physical, false);
  assert.deepEqual(commands, ["lsblk"]);
  telemetry.stop();
});
