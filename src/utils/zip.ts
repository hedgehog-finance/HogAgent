import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPathInside } from "./path-safety.ts";

interface ZipExtractCommand {
  command: string;
  args: string[];
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function getZipExtractCommand(zipPath: string, destinationDir: string, platform = process.platform): ZipExtractCommand {
  if (platform === "win32") {
    const quotedZipPath = quotePowerShellLiteral(zipPath);
    const quotedDestinationDir = quotePowerShellLiteral(destinationDir);
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${quotedZipPath} -DestinationPath ${quotedDestinationDir} -Force`,
      ],
    };
  }

  return {
    command: "unzip",
    args: ["-o", zipPath, "-d", destinationDir, "-x", "__MACOSX/*"],
  };
}

/**
 * Parses the ZIP central directory and returns every entry name without extracting data.
 * ZIP64 is unsupported because imported skill archives are far below its size threshold.
 */
function readZipEntryNames(zipPath: string): string[] {
  const buf = readFileSync(zipPath);
  // Scan backward for the EOCD signature, allowing a trailing ZIP comment.
  let eocd = -1;
  const minEocd = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Invalid zip: End of Central Directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid zip: bad central directory entry");
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const fileType = (buf.readUInt32LE(offset + 38) >>> 16) & 0xf000;
    if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
      throw new Error('Skill archives must contain only regular files and directories; links and special files are unsupported');
    }
    names.push(buf.toString("utf8", offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * Prevents zip-slip by rejecting absolute paths, drive letters, `..` traversal,
 * and any entry that escapes the destination directory before extraction.
 */
export function assertZipEntriesSafe(zipPath: string, destinationDir: string): void {
  for (const name of readZipEntryNames(zipPath)) {
    const normalized = name.replace(/\\/g, "/");
    const isAbsolute = normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized);
    const hasTraversal = normalized.split("/").includes("..");
    if (isAbsolute || hasTraversal || !isPathInside(destinationDir, join(destinationDir, normalized))) {
      throw new Error(`Zip entry escapes destination directory (zip-slip): ${name}`);
    }
  }
}

export function extractZipSync(zipPath: string, destinationDir: string, timeout = 30_000): void {
  assertZipEntriesSafe(zipPath, destinationDir);
  const { command, args } = getZipExtractCommand(zipPath, destinationDir);
  execFileSync(command, args, { timeout, windowsHide: true, stdio: "pipe" });
}
