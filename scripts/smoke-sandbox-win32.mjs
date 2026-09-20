import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// node-pty 是 PTY Provider 的私有依赖；根工作区不提升它，smoke 必须从其包边界解析。
const requirePty = createRequire(new URL("../packages/subprocess/subprocess-local/package.json", import.meta.url));
const { spawn: spawnPty } = requirePty("node-pty");

/**
 * Windows 原生沙箱真机验收。
 *
 * 默认跳过：它会创建 AppContainer Profile，并暂时向临时工作区授予 ACL。
 * 显式设 LCODE_E2E_SANDBOX_WIN32=1 后才运行；无论成功或失败都会请求 helper 撤销 ACL。
 */
if (process.env.LCODE_E2E_SANDBOX_WIN32 !== "1") {
  console.log(
    "跳过：Windows 原生沙箱真机验收需要显式设 LCODE_E2E_SANDBOX_WIN32=1",
  );
  process.exit(0);
}

if (process.platform !== "win32") {
  console.log("跳过：Windows 原生沙箱真机验收只能在 Windows 上运行");
  process.exit(0);
}

const helper = resolve(
  process.env.LCODE_SANDBOX_WIN32_HELPER ??
    "packages/sandbox/sandbox-win32/native/lcode-sandbox-win32.exe",
);
if (!existsSync(helper))
  throw new Error(`缺少 Windows 原生沙箱 helper：${helper}`);

const sandboxBase = resolve(
  process.env.LCODE_E2E_SANDBOX_BASE ?? tmpdir(),
);
if (!existsSync(sandboxBase))
  throw new Error(`沙箱验收临时目录不存在：${sandboxBase}`);
const root = mkdtempSync(join(sandboxBase, "lcode-sandbox-win32-"));
const workspace = join(root, "workspace");
const outside = join(root, "outside.txt");
let prepared = false;

try {
  mkdirSync(workspace, { recursive: true });

  const before = probe();
  console.log(`probe before: ${JSON.stringify(before)}`);
  console.log("prepare workspace ACL...");
  const preparedProbe = runJson([
    "--prepare",
    "--workspace",
    workspace,
    "--network",
    "deny",
  ]);
  prepared = true;
  assertEnforced(preparedProbe, "prepare");
  console.log("verify prepared ACL...");
  assertEnforced(probe(), "probe after prepare");

  console.log("verify workspace write...");
  runTarget(
    ["cmd.exe", "/d", "/s", "/c", "echo sandbox-ok> allowed.txt"],
    "workspace write",
  );
  if (!existsSync(join(workspace, "allowed.txt")))
    throw new Error("工作区内写入没有产生预期文件");

  console.log("verify controlled ConPTY launch...");
  await runPty(workspace);
  if (!existsSync(join(workspace, "pty-allowed.txt")))
    throw new Error("受控 PTY 未能在工作区内完成写入");

  console.log("verify outside-workspace write denial...");
  runTarget(
    ["cmd.exe", "/d", "/s", "/c", `echo sandbox-escape> ${outside}`],
    "outside workspace write",
    { mustFail: true },
  );
  if (existsSync(outside))
    throw new Error(`工作区外写入没有被阻止：${outside}`);

  console.log("verify network denial...");
  runTarget(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$client = [System.Net.Sockets.TcpClient]::new(); try { $client.Connect('1.1.1.1', 443); $client.Dispose(); exit 31 } catch [System.Net.Sockets.SocketException] { if ($_.Exception.SocketErrorCode -eq [System.Net.Sockets.SocketError]::AccessDenied) { exit 0 }; exit 32 } catch { exit 33 }",
    ],
    "network denial",
  );

  console.log("verify Job Object process cleanup...");
  const jobCheck = runJson(["--verify-job"]);
  if (jobCheck.jobObject !== true)
    throw new Error(`Job Object 进程清理未通过：${jobCheck.reason ?? "未知错误"}`);

  console.log(
    "Windows 原生沙箱真机验收通过：工作区 ACL、无网络 AppContainer 与 Job Object 进程树清理均已验证。",
  );
} finally {
  if (prepared) {
    console.log("revoke temporary workspace ACL...");
    const release = runJson(["--revoke", "--workspace", workspace]);
    if (release.released !== true)
      throw new Error(
        `临时工作区 ACL 撤销失败：${release.reason ?? "helper 未返回结构化回执"}`,
      );
  }
  rmSync(root, { recursive: true, force: true });
}

function probe() {
  return runJson(["--probe", "--workspace", workspace]);
}

function runTarget(target, label, options = {}) {
  const result = spawnSync(
    helper,
    ["--run", "--workspace", workspace, "--network", "deny", "--", ...target],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (result.error !== undefined)
    throw new Error(`${label} 启动 helper 失败：${result.error.message}`);
  if (options.mustFail === true) {
    if (result.status === 0)
      throw new Error(`${label} 意外成功，工作区边界没有生效`);
    return;
  }
  if (result.status !== 0)
    throw new Error(
      `${label} 未通过（exit=${result.status}）：${result.stderr.trim()} ${result.stdout.trim()}`,
    );
}

function runJson(args, options = {}) {
  const result = spawnSync(helper, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error !== undefined)
    throw new Error(`helper 启动失败：${result.error.message}`);
  if (result.status !== 0 && options.allowFailure !== true)
    throw new Error(
      `helper 调用失败（exit=${result.status}）：${result.stderr.trim()}`,
    );
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    if (options.allowFailure === true) return undefined;
    throw new Error(
      `helper 未返回 JSON：${result.stdout.trim()} ${result.stderr.trim()}`,
    );
  }
}

function assertEnforced(probeResult, label) {
  if (
    probeResult.appContainer === true &&
    probeResult.workspaceAcl === true &&
    probeResult.networkPolicy === true &&
    probeResult.jobObject === true
  )
    return;
  throw new Error(`${label} 未达到强制隔离：${JSON.stringify(probeResult)}`);
}

/**
 * 让 node-pty 承载 helper，而非直接启动 shell。helper 继承 ConPTY 句柄，再由
 * AppContainer 中的目标 shell 继承它们；这验证交互 I/O 没有绕过原生执行边界。
 */
async function runPty(workspace) {
  const pty = spawnPty(
    helper,
    ["--run", "--workspace", workspace, "--network", "deny", "--", "cmd.exe"],
    {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: workspace,
      env: process.env,
      useConpty: true,
      useConptyDll: true,
    },
  );
  let resolveExit;
  const exited = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  let sawMarker = false;
  let output = "";
  const exitSubscription = pty.onExit(({ exitCode }) => {
    resolveExit?.(exitCode);
  });
  try {
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("受控 PTY 未在超时时间内返回命令输出")), 10_000);
      const dataSubscription = pty.onData((data) => {
        output += data;
        if (output.includes("PTY_SANDBOX_OK")) {
          sawMarker = true;
          clearTimeout(timer);
          dataSubscription.dispose();
          resolvePromise();
        }
      });
      pty.onExit(({ exitCode }) => {
        clearTimeout(timer);
        dataSubscription.dispose();
        if (!sawMarker)
          reject(new Error(`受控 PTY 提前退出（exit=${exitCode}）：${output}`));
      });
      pty.write("echo pty-sandbox-ok> pty-allowed.txt\r\n");
      pty.write("echo PTY_SANDBOX_OK\r\n");
    });
  } finally {
    try {
      pty.kill();
    } catch {
      // helper 可能刚好随 shell 退出；无论如何 Job Object 会清理其进程树。
    }
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("关闭受控 PTY 超时")), 5_000)),
    ]);
    exitSubscription.dispose();
  }
}
