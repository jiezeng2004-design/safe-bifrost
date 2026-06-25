#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const root = resolve(scriptDir, "..");
const releaseDir = resolve(root, "release");
const archivePath = resolve(root, "patchwarden-release.tar.gz");

// Read version from package.json for zip naming
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
const zipArchivePath = resolve(root, `PatchWarden-v${pkg.version}.zip`);

const include = [
  "dist",
  "docs",
  "examples",
  "scripts",
  "src",
  "PatchWarden.cmd",
  ".gitignore",
  "LICENSE",
  "README.md",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
];

const forbidden = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.patchwarden([\\/]|$)/,
  /(^|[\\/])\.safe-bifrost([\\/]|$)/,
  /(^|[\\/])patchwarden\.config\.json$/,
  /(^|[\\/])safe-bifrost\.config\.json$/,
  /\.local\.(cmd|ps1)$/i,
  /\.dpapi$/i,
  /(^|[\\/])\.env$/,
  /\.log$/,
  /^docs[\\/]optimization-proposal\.md$/i,
  /(^|[\\/])kill-patchwarden\.(cmd|ps1)$/i,
];

// ── Minimal zip writer helpers (POSIX paths, DEFLATE via zlib) ────
// Defined before main execution so const CRC_TABLE is initialized.

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = (((date.getFullYear() - 1980) & 0x7F) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZip(files, outputPath) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const { dosTime, dosDate } = dosDateTime(now);

  for (const file of files) {
    const posixPath = file.path.replace(/\\/g, "/");
    const nameBuf = Buffer.from(posixPath, "utf-8");
    const content = file.content;
    const compressed = deflateRawSync(content);
    const useDeflate = compressed.length < content.length;
    const method = useDeflate ? 8 : 0;
    const data = useDeflate ? compressed : content;
    const crc = crc32(content);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    const localHeaderOffset = offset;
    localParts.push(Buffer.concat([lh, nameBuf, data]));
    offset += lh.length + nameBuf.length + data.length;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(localHeaderOffset, 42);
    centralParts.push(Buffer.concat([cd, nameBuf]));
  }

  const centralDir = Buffer.concat(centralParts);
  const centralDirOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outputPath, Buffer.concat([...localParts, centralDir, eocd]));
}

function readZipEntryNames(zipPath) {
  const buf = readFileSync(zipPath);
  const names = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const nameLen = buf.readUInt16LE(i + 28);
      const extraLen = buf.readUInt16LE(i + 30);
      const commentLen = buf.readUInt16LE(i + 32);
      const name = buf.toString("utf-8", i + 46, i + 46 + nameLen);
      names.push(name);
      i += 45 + nameLen + extraLen + commentLen;
    }
  }
  return names;
}

console.log("[pack-clean] Preparing clean release directory...");
rmSync(releaseDir, { recursive: true, force: true });
rmSync(archivePath, { force: true });
mkdirSync(releaseDir, { recursive: true });

for (const item of include) {
  const source = resolve(root, item);
  const target = resolve(releaseDir, item);
  if (!existsSync(source)) {
    console.log(`  skip missing: ${item}`);
    continue;
  }
  cpSync(source, target, {
    recursive: true,
    filter(sourcePath) {
      const rel = toPosix(relative(root, sourcePath));
      return !isForbidden(rel);
    },
  });
  console.log(`  copied: ${item}`);
}

const releaseFiles = listFiles(releaseDir);
const badReleaseEntries = releaseFiles.filter((file) =>
  isForbidden(toPosix(relative(releaseDir, file)))
);
if (badReleaseEntries.length > 0) {
  console.error("[pack-clean] Forbidden files in release directory:");
  for (const file of badReleaseEntries) {
    console.error(`  ${relative(releaseDir, file)}`);
  }
  process.exit(1);
}

console.log("[pack-clean] Creating tar.gz archive...");

// Convert Windows paths to WSL/Linux paths when tar is a Unix binary
function toTarPath(p) {
  if (process.platform === "win32") {
    return p;
  }
  return p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, "/");
}

const tarArchivePath = toTarPath(archivePath);
const tarReleaseDir = toTarPath(releaseDir);

execFileSync("tar", ["-czf", tarArchivePath, "-C", tarReleaseDir, "."], {
  stdio: "inherit",
});

const archiveEntries = execFileSync("tar", ["-tzf", tarArchivePath], {
  encoding: "utf-8",
})
  .split(/\r?\n/)
  .filter(Boolean)
  .map((entry) => toPosix(entry.replace(/^\.\//, "")));

const badArchiveEntries = archiveEntries.filter(isForbidden);
if (badArchiveEntries.length > 0) {
  console.error("[pack-clean] Forbidden files in archive:");
  for (const entry of badArchiveEntries) {
    console.error(`  ${entry}`);
  }
  rmSync(archivePath, { force: true });
  process.exit(1);
}

const sizeKb = (statSync(archivePath).size / 1024).toFixed(1);
console.log(`[pack-clean] Release directory: ${releaseFiles.length} files`);
console.log(`[pack-clean] tar.gz Archive: ${archivePath} (${sizeKb} KB)`);

// ── Create zip archive with POSIX path separators ─────────────────
console.log("[pack-clean] Creating zip archive with POSIX paths...");
rmSync(zipArchivePath, { force: true });

const zipFiles = releaseFiles.map((file) => {
  const rel = toPosix(relative(releaseDir, file));
  return { path: rel, content: readFileSync(file) };
});

createZip(zipFiles, zipArchivePath);

// Verify zip entries use POSIX separators
const zipEntryNames = readZipEntryNames(zipArchivePath);
const badZipEntries = zipEntryNames.filter((name) => name.includes("\\"));
if (badZipEntries.length > 0) {
  console.error("[pack-clean] Backslash path separators found in zip entries:");
  for (const name of badZipEntries.slice(0, 20)) {
    console.error(`  ${name}`);
  }
  rmSync(zipArchivePath, { force: true });
  process.exit(1);
}

const badZipForbidden = zipEntryNames.filter(isForbidden);
if (badZipForbidden.length > 0) {
  console.error("[pack-clean] Forbidden files in zip archive:");
  for (const entry of badZipForbidden) {
    console.error(`  ${entry}`);
  }
  rmSync(zipArchivePath, { force: true });
  process.exit(1);
}

const zipSizeKb = (statSync(zipArchivePath).size / 1024).toFixed(1);
console.log(`[pack-clean] zip Archive: ${zipArchivePath} (${zipSizeKb} KB, ${zipEntryNames.length} entries)`);
console.log("[pack-clean] OK");

function listFiles(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...listFiles(fullPath));
    } else {
      entries.push(fullPath);
    }
  }
  return entries;
}

function isForbidden(value) {
  return forbidden.some((pattern) => pattern.test(value));
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}
