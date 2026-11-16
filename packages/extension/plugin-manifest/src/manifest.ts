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
  /**
   * 渲染层（client）扩展（docs/30 §9）。
   *
   * 插件有两半：host 那一半在 utility process 里跑（工具/提示词/事件），
   * client 那一半在**渲染进程**里跑（界面、主题、面板）。没有这一半，
   * 任何"改外观/加面板"的需求都只能靠改应用源码——那等于插件体系缺了一整块。
   */
  readonly client?: PluginClientContribution;
}

export interface PluginClientContribution {
  /**
   * client 入口：包内 `./` 开头的 `.js`（ESM）。
   *
   * 与 host 的 `entry` 分开声明而不是共用一个文件：两者的**运行环境不同**
   * （一个有 Node 能力、一个只有浏览器 API），混在一起必然要用环境判断，
   * 那会让插件作者很容易写出"在渲染层 require fs"这种在一边能跑、另一边崩的代码。
   */
  readonly entry: string;
  /**
   * 这个 client 插件要占用的**插槽**。
   *
   * 必须显式声明：加载器据此决定何时实例化，也据此渲染到界面上。
   * 未声明的插槽不会被挂载——声明式比"插件自己找地方塞"更可控。
   */
  readonly slots: readonly PluginSlotId[];
}

/**
 * 可用的界面插槽（由渲染层提供，插件只能往这些位置挂）。
 *
 * 做成**枚举**而不是自由字符串：插槽是宿主给的挂载点，插件不能凭空创造位置。
 * 将来加新插槽是在这里加一项，插件作者读类型就知道有哪些可用。
 */
export type PluginSlotId =
  /** 全局主题：可覆盖 CSS 变量、设置背景图 */
  | "theme"
  /** 侧边栏底部：小面板（统计、快捷入口） */
  | "sidebar.bottom"
  /** 会话流上方：横幅/提示条 */
  | "conversation.top"
  /** 设置页：整页自定义面板 */
  | "settings.section"

const PLUGIN_SLOT_IDS: readonly PluginSlotId[] = [
  "theme",
  "sidebar.bottom",
  "conversation.top",
  "settings.section",
]

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
  rejectUnknown(value, ["tools", "services", "promptSections", "client"]);
  const tools = optionalStringArray(value, "tools");
  const services = optionalStringArray(value, "services");
  const promptSections = optionalStringArray(value, "promptSections");
  const client = optionalClient(value.client);
  return {
    ...(tools !== undefined ? { tools } : {}),
    ...(services !== undefined ? { services } : {}),
    ...(promptSections !== undefined ? { promptSections } : {}),
    ...(client !== undefined ? { client } : {}),
  };
}

/**
 * `contributes.client`：渲染层入口 + 插槽声明。
 *
 * `entry` 的校验与 host 侧同口径（包内 `./` 开头的 `.js`）——两者都会被 `import()`，
 * 允许绝对路径或 `..` 会让插件加载任意本机文件。
 */
function optionalClient(value: unknown): PluginClientContribution | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw manifestInvalid("contributes.client 必须是对象");
  rejectUnknown(value, ["entry", "slots"]);
  const entry = requiredString(value, "entry");
  if (
    !entry.startsWith("./") ||
    entry.includes("\\") ||
    entry.split("/").includes("..") ||
    !entry.endsWith(".js")
  ) {
    throw manifestInvalid("contributes.client.entry 必须是包内的 ./*.js ESM 相对路径");
  }
  const raw = value.slots;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw manifestInvalid("contributes.client.slots 必须是非空数组");
  }
  const slots: PluginSlotId[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !(PLUGIN_SLOT_IDS as readonly string[]).includes(item)) {
      throw manifestInvalid(`未知的界面插槽：${String(item)}。可用值：${PLUGIN_SLOT_IDS.join(" / ")}`);
    }
    if (!slots.includes(item as PluginSlotId)) slots.push(item as PluginSlotId);
  }
  return { entry, slots };
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
