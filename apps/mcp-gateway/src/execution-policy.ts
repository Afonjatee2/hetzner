import { access, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExecutionMode } from "@gpt-dev/schemas";
import { WorkspaceError } from "@gpt-dev/schemas";

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const PREPARATION_COMMANDS = new Set([
  "install", "i", "add", "fetch", "config", "store", "setup", "env", "self-update"
]);
const INFORMATION_FLAGS = new Set(["--version", "-v", "--help", "-h", "help"]);
const DEPENDENCY_MARKERS = ["node_modules", ".pnp.cjs", ".pnp.loader.mjs"];

export function requiresPreparedNodeDependencies(
  runtime: "node" | "python" | "generic",
  mode: ExecutionMode,
  executable: string,
  args: string[]
): boolean {
  if (runtime !== "node" || mode === "host") return false;
  if (!PACKAGE_MANAGERS.has(basename(executable))) return false;
  const first = args[0] ?? "";
  return !PREPARATION_COMMANDS.has(first) && !INFORMATION_FLAGS.has(first);
}

export async function hasPreparedNodeDependencies(worktreePath: string): Promise<boolean> {
  for (const marker of DEPENDENCY_MARKERS) {
    try {
      await access(join(worktreePath, marker));
      return true;
    } catch {
      // Check the next supported dependency marker.
    }
  }
  return false;
}

export type TaskCheckPreset =
  | "node-version"
  | "pnpm-version"
  | "git-diff-check"
  | "typecheck"
  | "lint"
  | "tests"
  | "electron-acceptance";

export interface PresetCommand {
  executable: string;
  args: string[];
}

const FIXED_PRESETS: Record<Exclude<TaskCheckPreset, "electron-acceptance">, PresetCommand> = {
  "node-version": { executable: "node", args: ["--version"] },
  "pnpm-version": { executable: "pnpm", args: ["--version"] },
  "git-diff-check": { executable: "git", args: ["diff", "--check"] },
  typecheck: { executable: "pnpm", args: ["typecheck"] },
  lint: { executable: "pnpm", args: ["lint"] },
  tests: { executable: "pnpm", args: ["test"] }
};

const ELECTRON_EXECUTABLES = new Set(["node", "pnpm", "npm", "npx", "bun"]);
const GIT_MUTATIONS = new Set([
  "reset", "clean", "stash", "rebase", "commit", "push", "merge",
  "checkout", "switch", "restore", "worktree"
]);

function wrappedGitSubcommand(command: PresetCommand): string | undefined {
  const executable = basename(command.executable);
  if (executable === "git") return command.args[0];
  if (executable === "npx" && command.args[0] === "git") return command.args[1];
  if (executable === "pnpm" && new Set(["exec", "dlx"]).has(command.args[0] ?? "")
    && command.args[1] === "git") return command.args[2];
  if (executable === "npm" && new Set(["exec", "x"]).has(command.args[0] ?? "")) {
    const offset = command.args[1] === "--" ? 2 : 1;
    if (command.args[offset] === "git") return command.args[offset + 1];
  }
  if (executable === "bun" && command.args[0] === "x" && command.args[1] === "git") return command.args[2];
  return undefined;
}

export function assertNonMutatingGitCommand(command: PresetCommand): void {
  const executable = basename(command.executable);
  if (executable === "node" && new Set(["-e", "--eval", "-p", "--print"]).has(command.args[0] ?? "")) {
    throw new WorkspaceError("FORBIDDEN", "Inline host code is forbidden for attached Electron acceptance");
  }
  const subcommand = wrappedGitSubcommand(command);
  if (subcommand && GIT_MUTATIONS.has(subcommand)) {
    throw new WorkspaceError("FORBIDDEN", "Git-changing commands are forbidden for attached workspaces");
  }
}

export async function resolveTaskCheckPreset(projectPath: string, preset: TaskCheckPreset): Promise<PresetCommand> {
  if (preset !== "electron-acceptance") return FIXED_PRESETS[preset];
  const packagePath = join(projectPath, "package.json");
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as {
    gptdev?: { electronAcceptance?: unknown };
  };
  const argv = parsed.gptdev?.electronAcceptance;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64
    || argv.some((value) => typeof value !== "string" || value.length === 0 || value.length > 4096)) {
    throw new WorkspaceError(
      "VALIDATION",
      "package.json gptdev.electronAcceptance must be a non-empty bounded argv string array"
    );
  }
  const [executable, ...args] = argv as string[];
  if (!executable || !ELECTRON_EXECUTABLES.has(basename(executable))) {
    throw new WorkspaceError("FORBIDDEN", "Electron acceptance executable is not approved");
  }
  const command = { executable, args };
  assertNonMutatingGitCommand(command);
  return command;
}

export async function createElectronEnvironment(root: string): Promise<Record<string, string>> {
  const paths = {
    home: join(root, "home"),
    config: join(root, "config"),
    cache: join(root, "cache"),
    data: join(root, "data"),
    temp: join(root, "temp"),
    userData: join(root, "electron-user-data"),
    screenshots: join(root, "screenshots"),
    traces: join(root, "traces"),
    logs: join(root, "logs")
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true, mode: 0o750 })));
  return {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache,
    XDG_DATA_HOME: paths.data,
    TMPDIR: paths.temp,
    ELECTRON_USER_DATA_DIR: paths.userData,
    GPTDEV_SCREENSHOTS_DIR: paths.screenshots,
    GPTDEV_TRACES_DIR: paths.traces,
    GPTDEV_LOGS_DIR: paths.logs
  };
}
