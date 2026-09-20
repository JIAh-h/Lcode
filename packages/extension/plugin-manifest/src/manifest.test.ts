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
