import { basenamePath } from "../utils/path-safety.ts";

export interface ShellCandidate {
  command: string;
  args: (shellCommand: string) => string[];
}

export function getShellCandidates(platform: NodeJS.Platform = process.platform): ShellCandidate[] {
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: (shellCommand) => [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          // Windows PowerShell 5 otherwise uses legacy code pages for pipes.
          "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false); " + shellCommand,
        ],
      },
      {
        command: "bash",
        args: (shellCommand) => ["-c", shellCommand],
      },
    ];
  }

  return [
    {
      command: "bash",
      args: (shellCommand) => ["-c", shellCommand],
    },
    {
      command: "sh",
      args: (shellCommand) => ["-c", shellCommand],
    },
  ];
}

function normalizedShellName(value: string): string {
  return basenamePath(value).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "");
}

export function getShellArguments(
  shell: string,
  shellCommand: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const shellName = normalizedShellName(shell);
  if (platform === "win32" && shellName === "cmd") {
    throw new Error("cmd.exe is not supported by the HogAgent Bash tool");
  }
  const candidate = getShellCandidates(platform).find(
    (item) => normalizedShellName(item.command) === shellName,
  );
  return candidate?.args(shellCommand) ?? ["-c", shellCommand];
}
