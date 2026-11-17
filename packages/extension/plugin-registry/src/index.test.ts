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

  /*
   * client 入口的安装期校验（docs/30 §P4）。
   *
   * 之前只校验 host 的 entry：client 入口写错时安装照样成功，
   * 直到渲染层 import 失败才暴露——而那条失败只打在控制台，
   * 用户看到的是"插件装了但界面没变"，极难归因。
   */
  it("拒绝缺失的 client 入口", async () => {
    const source = await createLocalPlugin({
      contributes: {
        client: { entry: "./dist/missing-client.js", slots: ["theme"] },
      },
    });
    await expect(
      registry().install({ source: { kind: "local", path: source } }),
    ).rejects.toMatchObject({ code: ERROR_CODES.EX_MANIFEST_INVALID });
    expect(registry().list()).toEqual([]);
  });

  it("接受 client 入口存在的插件", async () => {
    const source = await createLocalPlugin({
      contributes: {
        client: { entry: "./dist/client.js", slots: ["theme"] },
      },
    });
    await writeFile(
      join(source, "dist", "client.js"),
      "export function render() { return null }\n",
    );
    const result = await registry().install({
      source: { kind: "local", path: source },
    });
    expect(result.id).toBe("com.example.line-tools");
    expect(registry().list()).toHaveLength(1);
  });

  it("拒绝指向包外的 client 入口", async () => {
    const source = await createLocalPlugin({
      contributes: {
        // manifest 解析阶段就会拒绝 `..`，这里是第二道（路径穿越）
        client: { entry: "./../outside.js", slots: ["theme"] },
      },
    });
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

  it("只向生命周期提供仍与安装哈希一致的 entry，并持久化 enabled 状态", async () => {
    const source = await createLocalPlugin();
    await registry().install({ source: { kind: "local", path: source } });

    await expect(
      registry().activationSource({ id: "com.example.line-tools", version: "1.2.0" }),
    ).resolves.toMatchObject({
      manifest: { id: "com.example.line-tools", entry: "./dist/index.js" },
      entryPath: join(home, "plugins", "com.example.line-tools", "1.2.0", "dist", "index.js"),
    });
    await registry().setEnabled({ id: "com.example.line-tools", version: "1.2.0", enabled: true });
    expect(registry().list()[0]).toMatchObject({ state: "enabled" });

    await writeFile(
      join(home, "plugins", "com.example.line-tools", "1.2.0", "dist", "index.js"),
      "export const changed = true\n",
    );
    await expect(
      registry().activationSource({ id: "com.example.line-tools", version: "1.2.0" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.EX_MANIFEST_INVALID });
  });

  it("卸载会删除安装记录和快照", async () => {
    const source = await createLocalPlugin();
    await registry().install({ source: { kind: "local", path: source } });
    await registry().uninstall({ id: "com.example.line-tools", version: "1.2.0" });

    expect(registry().list()).toEqual([]);
    await expect(
      readFile(join(home, "plugins", "com.example.line-tools", "1.2.0", "lcode.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
