import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@lcode/util";
import { parsePluginManifest, PLUGIN_MANIFEST_SCHEMA } from "./manifest.ts";

const base = {
  $schema: PLUGIN_MANIFEST_SCHEMA,
  id: "com.example.line-tools",
  name: "Line Tools",
  version: "1.2.0",
  engines: { lcode: ">=0.1.0 <1.0.0" },
  entry: "./dist/index.js",
};

describe("parsePluginManifest", () => {
  it("规范化省略的权限与贡献为零能力", () => {
    expect(parsePluginManifest(base)).toMatchObject({
      permissions: {},
      contributes: {},
    });
  });

  it("解析声明权限与贡献", () => {
    const manifest = parsePluginManifest({
      ...base,
      permissions: {
        fs: { read: ["${workspace}/**"] },
        network: { domains: ["api.example.com"] },
      },
      contributes: {
        tools: ["count_lines"],
        promptSections: ["line-tools/hint"],
      },
    });
    expect(manifest.permissions).toEqual({
      fs: { read: ["${workspace}/**"] },
      network: { domains: ["api.example.com"] },
    });
    expect(manifest.contributes).toEqual({
      tools: ["count_lines"],
      promptSections: ["line-tools/hint"],
    });
  });

  /* ── client 贡献（docs/30 §9）：渲染层插件 ── */

  it("解析 client 贡献：入口 + 插槽", () => {
    const manifest = parsePluginManifest({
      ...base,
      contributes: {
        client: { entry: "./src/client.js", slots: ["theme", "sidebar.bottom"] },
      },
    });
    expect(manifest.contributes.client).toEqual({
      entry: "./src/client.js",
      slots: ["theme", "sidebar.bottom"],
    });
  });

  it("接受纯 client 插件（host 侧 entry 仍在，但可只放空 activate）", () => {
    const manifest = parsePluginManifest({
      ...base,
      contributes: { client: { entry: "./client.js", slots: ["settings.section"] } },
    });
    expect(manifest.contributes.client?.slots).toEqual(["settings.section"]);
    expect(manifest.contributes.tools).toBeUndefined();
  });

  it("client 插槽去重且保持声明顺序", () => {
    const manifest = parsePluginManifest({
      ...base,
      contributes: {
        client: { entry: "./c.js", slots: ["theme", "theme", "conversation.top"] },
      },
    });
    expect(manifest.contributes.client?.slots).toEqual(["theme", "conversation.top"]);
  });

  it.each([
    // client 入口必须是包内相对路径，与 host entry 同口径
    { entry: "../outside.js", slots: ["theme"] },
    { entry: "client.js", slots: ["theme"] },   // 缺 ./
    { entry: "C:/abs.js", slots: ["theme"] },
    { entry: "./c.ts", slots: ["theme"] },      // 必须 js
    // 插槽必须来自枚举
    { entry: "./c.js", slots: ["unknown.slot"] },
    { entry: "./c.js", slots: [] },
  ])("拒绝非法 client 声明：%j", (client) => {
    expect(caught(() => parsePluginManifest({ ...base, contributes: { client } }))).toMatchObject({
      code: ERROR_CODES.EX_MANIFEST_INVALID,
    });
  });

  it.each([
    [{ ...base, $schema: "https://lcode.dev/schema/plugin-999.json" }],
    [{ ...base, id: "Line Tools" }],
    [{ ...base, entry: "../outside.js" }],
    [{ ...base, permissions: { shell: { allow: ["cmd"] } } }],
    [{ ...base, unexpected: true }],
  ])("拒绝未知或不安全的字段", (input) => {
    expect(caught(() => parsePluginManifest(input))).toMatchObject({
      code: ERROR_CODES.EX_MANIFEST_INVALID,
    });
  });
});

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("预期 manifest 校验失败");
}
