import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import rcedit from 'rcedit'

/**
 * 生成 Windows portable staging 包（MVP 发布闭环）。
 *
 * 这不是自动更新器，也不是跨平台安装器；它是一个可在干净 Windows 机器上
 * 直接启动的目录包，先把运行时依赖和 ABI 产物收齐，避免“本机能跑、发布目录
 * 缺 zstd / better-sqlite3 / renderer”的假成功。
 */
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '../..')
const sourceDist = join(desktopRoot, 'dist')
const electronDist = join(desktopRoot, 'node_modules', 'electron', 'dist')
const sqlitePackage = join(desktopRoot, 'node_modules', 'better-sqlite3')
const sqliteNative = join(repoRoot, 'packages', 'session-persistence', 'session-persistence-sqlite', 'native')
const sandboxNative = join(repoRoot, 'packages', 'sandbox', 'sandbox-win32', 'native', 'lcode-sandbox-win32.exe')
const outRoot = join(repoRoot, 'out', 'lcode-win32-x64')
const appRoot = join(outRoot, 'resources', 'app')
const archivePath = join(repoRoot, 'out', 'lcode-win32-x64.zip')
const execFileAsync = promisify(execFile)

await requireFile(join(sourceDist, 'main.js'), '缺少主进程产物，请先完成桌面构建')
await requireFile(join(sourceDist, 'preload.js'), '缺少 preload 产物，请先完成桌面构建')
await requireFile(join(sourceDist, 'renderer', 'index.html'), '缺少 renderer 产物，请先完成桌面构建')
await requireFile(join(sourceDist, 'zstd.wasm'), '缺少 zstd.wasm，请先完成桌面构建')
await requireFile(join(electronDist, 'electron.exe'), '缺少 Electron runtime，请先安装桌面依赖')
await requireFile(sqlitePackage, '缺少 better-sqlite3，请先安装桌面依赖')
await requireFile(sqliteNative, '缺少 Electron ABI 原生模块，请先运行 native:build')
await requireFile(sandboxNative, '缺少 Windows 原生沙箱 helper，请先运行 native:build-sandbox-win32')

await rm(outRoot, { recursive: true, force: true })
await mkdir(appRoot, { recursive: true })

// Electron runtime（含 locales、resources.pak、V8 snapshot 等运行必需文件）。
await cp(electronDist, outRoot, { recursive: true, dereference: true })
await rename(join(outRoot, 'electron.exe'), join(outRoot, 'Lcode.exe'))

/*
 * rcedit 改写 exe 资源：不处理的话 Lcode.exe 沿用 Electron 默认图标与版本信息
 * （资源管理器、任务栏固定、快捷方式读的都是 exe 内嵌资源，BrowserWindow 的
 * `icon` 管不到这里）。失败就让打包失败——半成品图标比没有更糟。
 */
const appIcon = join(desktopRoot, 'resources', 'app_icon.ico')
await requireFile(appIcon, '缺少应用图标')
await rcedit(join(outRoot, 'Lcode.exe'), {
  icon: appIcon,
  'file-version': '0.1.0',
  'product-version': '0.1.0',
  'version-string': {
    FileDescription: 'Lcode',
    ProductName: 'Lcode',
    CompanyName: 'Lcode',
    OriginalFilename: 'Lcode.exe',
    InternalName: 'Lcode',
  },
})

await cp(sourceDist, join(appRoot, 'dist'), { recursive: true, dereference: true })
await mkdir(join(appRoot, 'native'), { recursive: true })
await cp(sandboxNative, join(appRoot, 'native', 'lcode-sandbox-win32.exe'), { dereference: true })
await writeFile(
  join(appRoot, 'package.json'),
  JSON.stringify({ name: 'lcode-desktop', version: '0.1.0', main: 'dist/main.js' }, null, 2) + '\n',
  'utf8',
)

// 主进程 bundle 对 better-sqlite3 保持 external；把 JS 包复制到 app 目录，
// native.ts 则通过下面的最小包根定位 Electron ABI 的显式 binding。
await mkdir(join(appRoot, 'node_modules'), { recursive: true })
await cp(sqlitePackage, join(appRoot, 'node_modules', 'better-sqlite3'), { recursive: true, dereference: true })
const sqliteBundleRoot = join(appRoot, 'node_modules', '@lcode', 'session-persistence-sqlite')
await mkdir(sqliteBundleRoot, { recursive: true })
await cp(sqliteNative, join(sqliteBundleRoot, 'native'), { recursive: true, dereference: true })
await writeFile(
  join(sqliteBundleRoot, 'package.json'),
  JSON.stringify({ name: '@lcode/session-persistence-sqlite', main: 'index.js' }, null, 2) + '\n',
  'utf8',
)
await writeFile(join(sqliteBundleRoot, 'index.js'), 'module.exports = {};\n', 'utf8')

const electronManifest = JSON.parse(await readFile(join(desktopRoot, 'node_modules', 'electron', 'package.json'), 'utf8'))
await rm(archivePath, { force: true })
// Windows 10+ 自带 bsdtar；避开 Windows PowerShell 上可选的 Archive 模块，
// 让干净机打包不依赖模块自动加载是否可用。
await execFileAsync('tar.exe', ['-a', '-c', '-f', archivePath, '-C', outRoot, '.'])
const manifest = {
  product: 'Lcode',
  version: '0.1.0',
  target: 'win32-x64-portable',
  electron: typeof electronManifest.version === 'string' ? electronManifest.version : 'unknown',
  generatedAt: new Date().toISOString(),
  executable: 'Lcode.exe',
  stagingBytes: await directoryBytes(outRoot),
  archive: 'lcode-win32-x64.zip',
  archiveBytes: (await stat(archivePath)).size,
  archiveLimitBytes: 150 * 1024 * 1024,
  nativeBinding: 'resources/app/node_modules/@lcode/session-persistence-sqlite/native/electron-130/better_sqlite3.node',
  sandboxHelper: 'resources/app/native/lcode-sandbox-win32.exe',
}
await writeFile(join(outRoot, 'lcode-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

console.log(`portable 包已生成：${outRoot}`)
console.log(`  分发压缩包：${archivePath}`)
console.log(`  启动文件：${join(outRoot, 'Lcode.exe')}`)
console.log(`  staging：${formatBytes(manifest.stagingBytes)}`)
console.log(`  分发包：${formatBytes(manifest.archiveBytes)} / 上限 150.0 MB`)
console.log(`  Electron：${manifest.electron}`)
console.log(`  SQLite ABI：${manifest.nativeBinding}`)
if (manifest.archiveBytes > manifest.archiveLimitBytes) {
  throw new Error(`分发压缩包超过 MVP 包体上限：${formatBytes(manifest.archiveBytes)} > 150.0 MB`)
}

async function requireFile(path, message) {
  try {
    await stat(path)
  } catch {
    throw new Error(`${message}：${path}`)
  }
}

async function directoryBytes(path) {
  const info = await stat(path)
  if (!info.isDirectory()) return info.size
  const entries = await (await import('node:fs/promises')).readdir(path, { withFileTypes: true })
  let total = 0
  for (const entry of entries) total += await directoryBytes(join(path, entry.name))
  return total
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
