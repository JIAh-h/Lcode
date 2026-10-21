import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  parsePluginManifest,
  type PluginContributes,
  type PluginManifest,
  type PluginPermissions,
} from "@lcode/plugin-manifest";
import { openIndexDb } from "@lcode/session-persistence-sqlite";
import { ERROR_CODES, LcodeErrorImpl } from "@lcode/util";

export interface PluginInstallSource {
  readonly kind: "local";
  readonly path: string;
}

export interface PluginInstallResult {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
  readonly permissions: PluginPermissions;
}

export interface PluginInfo {
  readonly id: string;
  readonly version: string;
  /** enabled is persisted intent; active is owned by the runtime lifecycle. */
  readonly state: "installed" | "enabled";
  readonly hash: string;
  readonly permissions: PluginPermissions;
  readonly contributes: PluginContributes;
  readonly source: "builtin" | "local" | "market";
  readonly installPath: string;
  readonly installedAt: number;
}

export interface PluginActivationSource {
  readonly manifest: PluginManifest;
  readonly entryPath: string;
}

export interface LocalPluginRegistryOptions {
  readonly home: string;
  readonly coreVersion: string;
  readonly db?: ReturnType<typeof openIndexDb> | undefined;
  readonly now?: (() => number) | undefined;
}

interface PluginRow {
  readonly id: string;
  readonly version: string;
  readonly content_hash: string;
  readonly permissions_json: string;
  readonly contributes_json: string;
  readonly install_path: string;
  readonly source: "builtin" | "local" | "market";
  readonly installed_at: number;
  readonly enabled: number;
}

/**
 * 只管理已安装的不可执行快照。P6-02 故意不 import() entry，也不提供 activate。
 * 后续 P6-03 的 utility host 只能消费本注册表已验证的安装记录。
 */
export class LocalPluginRegistry {
  private readonly db: ReturnType<typeof openIndexDb>;
  private readonly now: () => number;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: LocalPluginRegistryOptions) {
    this.db = options.db ?? openIndexDb({ home: options.home });
    this.now = options.now ?? Date.now;
  }

  list(
    input: { readonly includeBuiltin?: boolean } = {},
  ): readonly PluginInfo[] {
    const includeBuiltin = input.includeBuiltin ?? true;
    const rows = this.db
      .prepare(
        `SELECT id, version, content_hash, permissions_json, contributes_json, install_path, source, installed_at, enabled
         FROM plugins ${includeBuiltin ? "" : "WHERE source <> 'builtin'"} ORDER BY id ASC, version ASC`,
      )
      .all() as PluginRow[];
    return rows.map(toPluginInfo);
  }

  async install(input: {
    readonly source: PluginInstallSource;
  }): Promise<PluginInstallResult> {
    if (input.source.kind !== "local")
      throw invalidParams("P6-02 仅支持本地插件目录");
    if (
      typeof input.source.path !== "string" ||
      input.source.path.trim() === ""
    )
      throw invalidParams("source.path 必填");
    return await this.enqueue(
      async () => await this.installLocal(input.source.path),
    );
  }

  /** Re-check the immutable snapshot before lifecycle code ever receives its entry path. */
  async activationSource(input: {
    readonly id: string;
    readonly version: string;
  }): Promise<PluginActivationSource> {
    const row = this.row(input);
    const manifest = await readManifest(row.install_path);
    await validatePackage(row.install_path, manifest);
    if ((await hashDirectory(row.install_path)) !== row.content_hash) {
      throw manifestInvalid(`${input.id}@${input.version} 的安装快照已被修改`);
    }
    if (
      JSON.stringify(manifest.permissions) !== row.permissions_json ||
      JSON.stringify(manifest.contributes) !== row.contributes_json
    ) {
      throw manifestInvalid(`${input.id}@${input.version} 的清单声明与安装记录不一致`);
    }
    return { manifest, entryPath: resolve(row.install_path, manifest.entry) };
  }

  async setEnabled(input: {
    readonly id: string;
    readonly version: string;
    readonly enabled: boolean;
  }): Promise<void> {
    await this.enqueue(async () => {
      this.row(input);
      this.db
        .prepare(
          "UPDATE plugins SET enabled = ?, activated_at = ? WHERE id = ? AND version = ?",
        )
        .run(input.enabled ? 1 : 0, input.enabled ? this.now() : null, input.id, input.version);
    });
  }

  async uninstall(input: {
    readonly id: string;
    readonly version: string;
  }): Promise<void> {
    await this.enqueue(async () => {
      const row = this.row(input);
      const root = join(this.options.home, "plugins");
      if (!isInside(root, row.install_path)) {
        throw manifestInvalid("安装记录指向插件目录之外，拒绝删除");
      }
      const trash = await mkdtemp(join(root, ".removing-"));
      const moved = join(trash, "snapshot");
      try {
        await rename(row.install_path, moved);
        try {
          this.db
            .prepare("DELETE FROM plugins WHERE id = ? AND version = ?")
            .run(input.id, input.version);
        } catch (error) {
          await rename(moved, row.install_path);
          throw error;
        }
        await rm(trash, { recursive: true, force: true });
      } catch (error) {
        await rm(trash, { recursive: true, force: true });
        throw error;
      }
    });
  }

  private async installLocal(sourcePath: string): Promise<PluginInstallResult> {
    const source = resolve(sourcePath);
    const sourceStat = await statOrManifestInvalid(
      source,
      "本地插件目录不存在或不可访问",
    );
    if (!sourceStat.isDirectory())
      throw manifestInvalid("本地插件 source.path 必须是目录");

    const root = join(this.options.home, "plugins");
    const stagingParent = join(root, ".staging");
    await mkdir(stagingParent, { recursive: true });
    const staging = await mkdtemp(join(stagingParent, "install-"));
    try {
      if (isInside(source, staging))
        throw manifestInvalid("插件源目录不能包含 Lcode 插件安装目录");
      await snapshotDirectory(source, staging);
      const manifest = await readManifest(staging);
      await validatePackage(staging, manifest);
      assertCompatible(manifest.engines.lcode, this.options.coreVersion);
      const contentHash = await hashDirectory(staging);
      const manifestHash = sha256(await readFile(join(staging, "lcode.json")));
      const target = join(root, manifest.id, manifest.version);

      const existing = this.db
        .prepare(
          "SELECT content_hash FROM plugins WHERE id = ? AND version = ?",
        )
        .get(manifest.id, manifest.version) as
        { readonly content_hash: string } | undefined;
      if (existing !== undefined) {
        throw manifestInvalid(
          existing.content_hash === contentHash
            ? `${manifest.id}@${manifest.version} 已安装`
            : `${manifest.id}@${manifest.version} 的内容已变化；必须提升 version`,
        );
      }

      try {
        await stat(target);
        throw manifestInvalid(
          `${manifest.id}@${manifest.version} 的安装目录已存在但未登记`,
        );
      } catch (error) {
        if (isLcodePluginError(error)) throw error;
      }

      await mkdir(dirname(target), { recursive: true });
      await rename(staging, target);
      try {
        this.db
          .prepare(
            `INSERT INTO plugins (
              id, version, manifest_hash, content_hash, permissions_json, contributes_json,
              enabled, install_path, source, engines_lcode, granted_at, installed_at, activated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'local', ?, NULL, ?, NULL)`,
          )
          .run(
            manifest.id,
            manifest.version,
            manifestHash,
            contentHash,
            JSON.stringify(manifest.permissions),
            JSON.stringify(manifest.contributes),
            target,
            manifest.engines.lcode,
            this.now(),
          );
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        throw error;
      }
      return {
        id: manifest.id,
        version: manifest.version,
        hash: contentHash,
        permissions: manifest.permissions,
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private row(input: { readonly id: string; readonly version: string }): PluginRow {
    const row = this.db
      .prepare(
        `SELECT id, version, content_hash, permissions_json, contributes_json, install_path, source, installed_at, enabled
         FROM plugins WHERE id = ? AND version = ?`,
      )
      .get(input.id, input.version) as PluginRow | undefined;
    if (row === undefined) throw notFound(`${input.id}@${input.version} 未安装`);
    return row;
  }
}

async function readManifest(root: string): Promise<PluginManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(root, "lcode.json"), "utf8"),
    ) as unknown;
  } catch (error) {
    throw manifestInvalid("无法读取 lcode.json", error);
  }
  return parsePluginManifest(parsed);
}

async function validatePackage(
  root: string,
  manifest: PluginManifest,
): Promise<void> {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as unknown;
  } catch (error) {
    throw manifestInvalid("无法读取 package.json", error);
  }
  if (!isRecord(packageJson) || packageJson.type !== "module")
    throw manifestInvalid("package.json 必须声明 type: module");
  const entry = resolve(root, manifest.entry);
  if (!isInside(root, entry)) throw manifestInvalid("entry 不能指向插件包外");
  const entryStat = await statOrManifestInvalid(
    entry,
    "entry 文件不存在或不可访问",
  );
  if (!entryStat.isFile()) throw manifestInvalid("entry 必须是普通文件");
}

async function snapshotDirectory(
  source: string,
  target: string,
): Promise<void> {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink())
      throw manifestInvalid(`不支持符号链接：${entry.name}`);
    if (info.isDirectory()) {
      await snapshotDirectory(from, to);
    } else if (info.isFile()) {
      await copyFile(from, to);
    } else {
      throw manifestInvalid(`不支持特殊文件：${entry.name}`);
    }
  }
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).replaceAll("\\", "/");
      const info = await lstat(path);
      if (info.isDirectory()) {
        hash.update(`d\u0000${rel}\u0000`);
        await walk(path);
      } else if (info.isFile()) {
        hash.update(`f\u0000${rel}\u0000`);
        hash.update(await readFile(path));
        hash.update("\u0000");
      } else {
        throw manifestInvalid(`快照中存在不支持的文件：${rel}`);
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

function assertCompatible(range: string, coreVersion: string): void {
  const core = parseSemver(coreVersion);
  const comparators = range.trim().split(/\s+/).filter(Boolean);
  if (
    comparators.length === 0 ||
    !comparators.every((comparator) => satisfies(core, comparator))
  ) {
    throw new LcodeErrorImpl({
      code: ERROR_CODES.EX_INCOMPATIBLE,
      message: `插件要求 Lcode ${range}，当前为 ${coreVersion}`,
      userMessage: "这个扩展和当前版本不匹配，先升级 Lcode 吧。",
      retryable: false,
    });
  }
}

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseSemver(value: string): Semver {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(value);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  )
    throw manifestInvalid(`不支持的 semver：${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function satisfies(version: Semver, raw: string): boolean {
  if (raw === "*") return true;
  const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)$/.exec(raw);
  if (match?.[2] === undefined)
    throw manifestInvalid(`不支持的 engines.lcode 范围：${raw}`);
  const target = parseSemver(match[2]);
  const compared = compareSemver(version, target);
  switch (match[1] ?? "=") {
    case ">=":
      return compared >= 0;
    case "<=":
      return compared <= 0;
    case ">":
      return compared > 0;
    case "<":
      return compared < 0;
    case "=":
      return compared === 0;
    case "^":
      return version.major === target.major && compared >= 0;
    case "~":
      return (
        version.major === target.major &&
        version.minor === target.minor &&
        compared >= 0
      );
    default:
      throw manifestInvalid(`不支持的 engines.lcode 比较符：${raw}`);
  }
}

function compareSemver(left: Semver, right: Semver): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

function toPluginInfo(row: PluginRow): PluginInfo {
  return {
    id: row.id,
    version: row.version,
    state: row.enabled === 1 ? "enabled" : "installed",
    hash: row.content_hash,
    permissions: JSON.parse(row.permissions_json) as PluginPermissions,
    contributes: JSON.parse(row.contributes_json) as PluginContributes,
    source: row.source,
    installPath: row.install_path,
    installedAt: row.installed_at,
  };
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path !== "" &&
    !path.startsWith("../") &&
    !path.startsWith("..\\") &&
    path !== ".." &&
    !isAbsolute(path)
  );
}

async function statOrManifestInvalid(path: string, message: string) {
  try {
    return await stat(path);
  } catch (error) {
    throw manifestInvalid(message, error);
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLcodePluginError(error: unknown): error is LcodeErrorImpl {
  return error instanceof LcodeErrorImpl && error.category === "plugin";
}

function invalidParams(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_INVALID_PARAMS,
    message,
    userMessage: "这个请求的参数不对。",
    retryable: false,
  });
}

function notFound(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_NOT_FOUND,
    message,
    userMessage: "找不到这个扩展。",
    retryable: false,
  });
}

function manifestInvalid(message: string, cause?: unknown): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EX_MANIFEST_INVALID,
    message: `插件清单非法：${message}`,
    userMessage: "这个扩展的说明书有问题，装不了。",
    retryable: false,
    ...(cause !== undefined ? { cause } : {}),
  });
}
