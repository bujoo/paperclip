import fs from "node:fs";
import path from "node:path";

function toGlobstarPath(candidate: string): string {
  return `${candidate.replaceAll(path.sep, "/")}/**`;
}

function addIgnorePath(target: Set<string>, candidate: string): void {
  target.add(candidate);
  target.add(toGlobstarPath(candidate));
  try {
    const realPath = fs.realpathSync(candidate);
    target.add(realPath);
    target.add(toGlobstarPath(realPath));
  } catch {
    // Ignore paths that do not exist in the current checkout.
  }
}

export function resolveServerDevWatchIgnorePaths(serverRoot: string): string[] {
  const ignorePaths = new Set<string>([
    "**/{node_modules,bower_components,vendor}/**",
    "**/.vite-temp/**",
    // Workspace package build outputs. The plugin-dev-watcher hot-reloads
    // plugin workers from these dirs WITHIN the running server, so the
    // server itself must NOT restart when they change. Restarts during
    // active runs reap in-flight Hermes children as process_lost (MYA-94).
    "**/packages/**/dist/**",
    "**/packages/plugins/**/dist/**",
    "**/.git/**",
  ]);

  for (const relativePath of [
    "../ui/node_modules",
    "../ui/node_modules/.vite-temp",
    "../ui/.vite",
    "../ui/dist",
    // npm install during reinstall would trigger a restart mid-request
    // if tsx watch sees the new files. Exclude the managed plugins dir.
    process.env.HOME + "/.paperclip/adapter-plugins",
    // Explicitly exclude every workspace package's dist output so absolute-
    // path globs catch them on tsx/chokidar (which only matches the patterns
    // it sees, not arbitrary globs across symlinks).
    "../packages/shared/dist",
    "../packages/db/dist",
    "../packages/adapter-utils/dist",
    "../packages/mcp-server/dist",
    "../packages/plugins/sdk/dist",
    "../packages/plugins/plugin-holacracy/dist",
    "../packages/plugins/plugin-mcp-manager/dist",
    "../packages/plugins/plugin-docs/dist",
    "../packages/plugins",
  ]) {
    addIgnorePath(ignorePaths, path.resolve(serverRoot, relativePath));
  }

  return [...ignorePaths];
}
