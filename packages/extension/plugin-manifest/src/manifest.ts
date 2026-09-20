import type { JsonValue } from "@lcode/util";
import { ERROR_CODES, LcodeErrorImpl } from "@lcode/util";

/** P6 的唯一已支持 manifest schema；未知版本必须显式拒绝。 */
export const PLUGIN_MANIFEST_SCHEMA = "https://lcode.dev/schema/plugin-1.json";

export interface PluginPermissions {
  readonly fs?: {
    readonly read?: readonly string[];
    readonly write?: readonly string[];
  };
  readonly network?: { readonly domains?: readonly string[] };
  readonly spawn?: { readonly allow?: readonly string[] };
  readonly env?: { readonly read?: readonly string[] };
}

export interface PluginContributes {
  readonly tools?: readonly string[];
  readonly services?: readonly string[];
  readonly promptSections?: readonly string[];
}

export interface PluginActivation {
  readonly events?: readonly string[];
  readonly languages?: readonly string[];
  readonly workspaceTrust?: "trusted";
}

/** 插件清单（`lcode.json`，文档 13 §3.5）。 */
export interface PluginManifest {
  readonly $schema: typeof PLUGIN_MANIFEST_SCHEMA;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly engines: { readonly lcode: string };
  readonly entry: string;
  readonly activation?: PluginActivation | undefined;
  /** 省略等价于零权限，不作任何隐式放宽。 */
  readonly permissions: PluginPermissions;
  readonly configSchema?: JsonValue | undefined;
  readonly contributes: PluginContributes;
}

const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 对不可信 JSON 的唯一入口；安装前不加载插件代码。 */
export function parsePluginManifest(value: unknown): PluginManifest {
  if (!isRecord(value)) throw manifestInvalid("lcode.json 必须是对象");
  rejectUnknown(value, [
    "$schema",
    "id",
    "name",
    "version",
    "engines",
    "entry",
    "activation",
    "permissions",
    "configSchema",
    "contributes",
  ]);

  const schema = requiredString(value, "$schema");
  if (schema !== PLUGIN_MANIFEST_SCHEMA)
    throw manifestInvalid(`不支持的 manifest schema：${schema}`);

  const id = requiredString(value, "id");
  if (!PLUGIN_ID.test(id))
    throw manifestInvalid("id 必须是至少两段的小写反向域名标识");
  const name = requiredString(value, "name");
  const version = requiredString(value, "version");
  if (!SEMVER.test(version)) throw manifestInvalid("version 必须是合法 semver");

  const engines = requiredRecord(value, "engines");
  rejectUnknown(engines, ["lcode"]);
  const lcode = requiredString(engines, "lcode");
  if (lcode.trim() === "") throw manifestInvalid("engines.lcode 不能为空");

  const entry = requiredString(value, "entry");
  if (
    !entry.startsWith("./") ||
    entry.includes("\\") ||
    entry.split("/").includes("..") ||
    !entry.endsWith(".js")
  ) {
    throw manifestInvalid("entry 必须是包内的 ./*.js ESM 相对路径");
  }

  const activation = optionalActivation(value.activation);
  const permissions = optionalPermissions(value.permissions);
  const configSchema = optionalJson(value, "configSchema");
  const contributes = optionalContributes(value.contributes);

  return {
    $schema: PLUGIN_MANIFEST_SCHEMA,
    id,
    name,
    version,
    engines: { lcode },
    entry,
    ...(activation !== undefined ? { activation } : {}),
    permissions,
    ...(configSchema !== undefined ? { configSchema } : {}),
    contributes,
  };
}

function optionalActivation(value: unknown): PluginActivation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw manifestInvalid("activation 必须是对象");
  rejectUnknown(value, ["events", "languages", "workspaceTrust"]);
  const events = optionalStringArray(value, "events");
  const languages = optionalStringArray(value, "languages");
  const workspaceTrust = value.workspaceTrust;
  if (workspaceTrust !== undefined && workspaceTrust !== "trusted")
    throw manifestInvalid("activation.workspaceTrust 仅支持 trusted");
  return {
    ...(events !== undefined ? { events } : {}),
    ...(languages !== undefined ? { languages } : {}),
    ...(workspaceTrust !== undefined ? { workspaceTrust } : {}),
  };
}

function optionalPermissions(value: unknown): PluginPermissions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw manifestInvalid("permissions 必须是对象");
  rejectUnknown(value, ["fs", "network", "spawn", "env"]);
  return {
    ...(value.fs !== undefined
      ? { fs: readWriteRule(value.fs, "permissions.fs") }
      : {}),
    ...(value.network !== undefined
      ? { network: namedRule(value.network, "permissions.network", "domains") }
      : {}),
    ...(value.spawn !== undefined
      ? { spawn: namedRule(value.spawn, "permissions.spawn", "allow") }
      : {}),
    ...(value.env !== undefined
      ? { env: namedRule(value.env, "permissions.env", "read") }
      : {}),
  };
}

function readWriteRule(
  value: unknown,
  name: string,
): { readonly read?: readonly string[]; readonly write?: readonly string[] } {
  if (!isRecord(value)) throw manifestInvalid(`${name} 必须是对象`);
  rejectUnknown(value, ["read", "write"]);
  const read = optionalStringArray(value, "read");
  const write = optionalStringArray(value, "write");
  return {
    ...(read !== undefined ? { read } : {}),
    ...(write !== undefined ? { write } : {}),
  };
}

function namedRule(
  value: unknown,
  name: string,
  key: string,
): { readonly [key: string]: readonly string[] | undefined } {
  if (!isRecord(value)) throw manifestInvalid(`${name} 必须是对象`);
  rejectUnknown(value, [key]);
  const entries = optionalStringArray(value, key);
  return entries === undefined ? {} : { [key]: entries };
}

function optionalContributes(value: unknown): PluginContributes {
  if (value === undefined) return {};
  if (!isRecord(value)) throw manifestInvalid("contributes 必须是对象");
  rejectUnknown(value, ["tools", "services", "promptSections"]);
  const tools = optionalStringArray(value, "tools");
  const services = optionalStringArray(value, "services");
  const promptSections = optionalStringArray(value, "promptSections");
  return {
    ...(tools !== undefined ? { tools } : {}),
    ...(services !== undefined ? { services } : {}),
    ...(promptSections !== undefined ? { promptSections } : {}),
  };
}

function optionalJson(
  record: Record<string, unknown>,
  key: string,
): JsonValue | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isJsonValue(value)) throw manifestInvalid(`${key} 必须是 JSON 值`);
  return value;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw manifestInvalid(`${key} 必须是非空字符串数组`);
  }
  return [...value];
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "")
    throw manifestInvalid(`${key} 必填且必须是非空字符串`);
  return value;
}

function requiredRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw manifestInvalid(`${key} 必填且必须是对象`);
  return value;
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw manifestInvalid(`不支持的 manifest 字段：${unknown}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function manifestInvalid(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EX_MANIFEST_INVALID,
    message: `插件清单非法：${message}`,
    userMessage: "这个扩展的说明书有问题，装不了。",
    retryable: false,
  });
}
