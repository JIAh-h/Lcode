import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { closeIndexDb } from "@lcode/session-persistence-sqlite";
import { ERROR_CODES } from "@lcode/util";
import { LocalPluginRegistry } from "./index.ts";

let testRoot = "";
let home = "";

afterEach(async () => {
  if (home !== "") closeIndexDb(home);
  if (testRoot !== "") await rm(testRoot, { recursive: true, force: true });
  testRoot = "";
  home = "";
});

async function createLocalPlugin(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  testRoot = await mkdtemp(join(tmpdir(), "lcode-plugin-registry-"));
  home = join(testRoot, "home");
  const source = join(testRoot, "source");
  await mkdir(join(source, "dist"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "line-tools", type: "module" }),
  );
  await writeFile(
    join(source, "dist", "index.js"),
    "export const tools = []\n",
  );
  await writeFile(
    join(source, "lcode.json"),
    JSON.stringify({
      $schema: "https://lcode.dev/schema/plugin-1.json",
      id: "com.example.line-tools",
      name: "Line Tools",
      version: "1.2.0",
      engines: { lcode: ">=0.1.0 <1.0.0" },
      entry: "./dist/index.js",
      permissions: { fs: { read: ["${workspace}/**"] } },
      contributes: { tools: ["count_lines"] },
      ...overrides,
    }),
  );
  return source;
}

function registry(): LocalPluginRegistry {
  return new LocalPluginRegistry({
    home,
    coreVersion: "0.1.0",
    now: () => 123,
  });
}

describe("LocalPluginRegistry", () => {
  it("复制经过校验的本地快照，落安装记录但不激活", async () => {
    const source = await createLocalPlugin();
    const result = await registry().install({
      source: { kind: "local", path: source },
    });

    expect(result).toMatchObject({
      id: "com.example.line-tools",
      version: "1.2.0",
      permissions: { fs: { read: ["${workspace}/**"] } },
    });
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    const installed = registry().list();
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      id: "com.example.line-tools",
      version: "1.2.0",
      state: "installed",
      source: "local",
      installedAt: 123,
      contributes: { tools: ["count_lines"] },
    });
    expect(
      await readFile(
        join(
          home,
          "plugins",
          "com.example.line-tools",
          "1.2.0",
          "dist",
          "index.js",
        ),
        "utf8",
      ),
    ).toContain("tools");
  });

  it("拒绝不兼容版本，且不留下安装记录", async () => {
    const source = await createLocalPlugin({
      engines: { lcode: ">=1.0.0 <2.0.0" },
    });
    await expect(
      registry().install({ source: { kind: "local", path: source } }),
    ).rejects.toMatchObject({ code: ERROR_CODES.EX_INCOMPATIBLE });
    expect(registry().list()).toEqual([]);
  });

  it("拒绝缺失入口的清单，且不留下安装记录", async () => {
    const source = await createLocalPlugin({ entry: "./dist/missing.js" });
    await expect(
      registry().install({ source: { kind: "local", path: source } }),
    ).rejects.toMatchObject({ code: ERROR_CODES.EX_MANIFEST_INVALID });
    expect(registry().list()).toEqual([]);
  });

  it("同一 id/version 不能被不同内容覆写", async () => {
    const source = await createLocalPlugin();
    await registry().install({ source: { kind: "local", path: source } });
    await writeFile(
      join(source, "dist", "index.js"),
      'export const tools = ["changed"]\n',
    );
    await expect(
      registry().install({ source: { kind: "local", path: source } }),
    ).rejects.toMatchObject({ code: ERROR_CODES.EX_MANIFEST_INVALID });
    expect(registry().list()).toHaveLength(1);
  });
});
