import { test } from "node:test";
import assert from "node:assert/strict";
import {
  storageMedia,
  sanitizeStorageMedia,
  udevMediaAttributes,
} from "../lib/storage-media.mjs";
import { linuxDisks } from "../lib/host-platform.mjs";
import { parseWindowsDisks } from "../lib/windows-disks.mjs";

test("USB rotation and explicit media flags distinguish HDD, flash and uncertain solid state", () => {
  assert.equal(
    storageMedia({ transport: "usb", rotational: true }).mediaKind,
    "hdd",
  );
  assert.equal(
    storageMedia({ transport: "usb", rotational: false }).mediaKind,
    "solid-state",
  );
  assert.equal(
    storageMedia({
      transport: "usb",
      rotational: false,
      attributes: { ID_DRIVE_THUMB: "1" },
    }).mediaKind,
    "flash",
  );
  assert.equal(
    storageMedia({ transport: "USB", nativeMedia: "SSD" }).mediaKind,
    "ssd",
  );
  assert.deepEqual(storageMedia({ transport: "usb" }), { transport: "usb" });
  assert.equal(
    storageMedia({ transport: "sata", rotational: false }).mediaKind,
    "ssd",
  );
});
test("SD and MMC use typed kernel/udev metadata, never a guessed model name", () => {
  assert.equal(
    storageMedia({ transport: "sdio", attributes: { MMC_TYPE: "SD" } })
      .mediaKind,
    "sd",
  );
  assert.equal(
    storageMedia({ transport: "mmc", attributes: { MMC_TYPE: "MMC" } })
      .mediaKind,
    "mmc",
  );
  assert.equal(
    storageMedia({
      transport: "usb",
      attributes: { ID_DRIVE_MEDIA_FLASH_SD: "1" },
    }).mediaKind,
    "sd",
  );
  assert.equal(storageMedia({ transport: "sdio" }).mediaKind, undefined);
  assert.deepEqual(
    sanitizeStorageMedia({
      transport: "my secret",
      mediaKind: "unknown guessed SSD",
      removable: "true",
      hotplug: true,
      serial: "private",
    }),
    { hotplug: true },
  );
  assert.deepEqual(
    udevMediaAttributes(
      "E:ID_SERIAL=private\nE:ID_DRIVE_THUMB=1\nE:MMC_TYPE=SD\nE:ID_DRIVE_FLASH_SD=0",
    ),
    { ID_DRIVE_THUMB: "1", MMC_TYPE: "SD", ID_DRIVE_FLASH_SD: "0" },
  );
});
test("Linux reads bounded per-device media data and hot removal does not retain the previous disk", async () => {
  let connected = true;
  const reads = [];
  const collect = () =>
    linuxDisks({
      run: async () =>
        JSON.stringify({
          blockdevices: connected
            ? [
                {
                  name: "sdb",
                  type: "disk",
                  size: 100,
                  tran: "usb",
                  rota: false,
                  rm: true,
                  hotplug: true,
                },
              ]
            : [],
        }),
      read: async (file) => {
        reads.push(file);
        if (file.endsWith("/dev")) return "8:16\n";
        if (file === "/run/udev/data/b8:16")
          return "E:ID_DRIVE_THUMB=1\nE:ID_SERIAL=private";
        throw Error("Unavailable");
      },
    });
  const first = await collect();
  assert.equal(first[0].mediaKind, "flash");
  assert.equal(first[0].removable, true);
  assert.equal(first[0].hotplug, true);
  assert.equal(JSON.stringify(first).includes("private"), false);
  assert.deepEqual(reads, ["/sys/class/block/sdb/dev", "/run/udev/data/b8:16"]);
  connected = false;
  assert.deepEqual(await collect(), []);
});
test("native Windows disk media survives parsing without applying its type to unreported devices", () => {
  const disks = parseWindowsDisks({
    Disks: [
      {
        Index: 0,
        Size: 100,
        Model: "Storage",
        BusType: "NVMe",
        MediaType: "SSD",
      },
      {
        Index: 1,
        Size: 100,
        Model: "USB SSD",
        BusType: "USB",
        Removable: true,
      },
    ],
  });
  assert.equal(disks[0].mediaKind, "ssd");
  assert.equal(disks[0].transport, "nvme");
  assert.equal(disks[1].mediaKind, undefined);
  assert.equal(disks[1].removable, true);
});
