import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const summaryPath = resolve(root, "coverage/coverage-summary.json");

if (!existsSync(summaryPath)) {
  console.error(
    `缺少覆盖率摘要：${relative(root, summaryPath)}。请先运行 vitest run --coverage。`,
  );
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const metrics = ["lines", "branches", "functions", "statements"];
const files = Object.entries(summary).filter(
  ([file]) => file !== "total" && toRepoPath(file).startsWith("packages/core/"),
);
const failures = [];

if (files.length === 0) {
  console.error("覆盖率摘要中没有核心包文件，拒绝通过门禁。");
  process.exit(1);
}

for (const [file, data] of files) {
  const repoFile = toRepoPath(file);
  for (const metric of metrics) {
    const percent = data[metric]?.pct;
    if (typeof percent !== "number" || percent < 100)
      failures.push(`${repoFile}: ${metric}=${formatPercent(percent)}`);
  }
}

if (failures.length > 0) {
  console.error(
    `T7.2 覆盖率门禁失败（核心文件 ${files.length} 个，逐文件要求 100%）：`,
  );
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`T7.2 覆盖率门禁通过：${files.length} 个核心文件逐文件达到 100%。`);

function toRepoPath(file) {
  return relative(root, resolve(file)).replaceAll("\\", "/");
}

function formatPercent(value) {
  return typeof value === "number" ? `${value.toFixed(2)}%` : "missing";
}
