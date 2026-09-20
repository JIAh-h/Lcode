import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nativeRoot = join(repoRoot, 'packages', 'sandbox', 'sandbox-win32', 'native')
const source = join(nativeRoot, 'lcode_sandbox_win32.cpp')
const output = join(nativeRoot, 'lcode-sandbox-win32.exe')
const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')

if (process.platform !== 'win32') throw new Error('native:build-sandbox-win32 仅支持在 Windows 上构建。')
await stat(source)
await mkdir(nativeRoot, { recursive: true })

const { stdout } = await execFileAsync(vswhere, [
  '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath',
])
const installation = stdout.trim()
if (installation === '') {
  throw new Error('未找到 Visual Studio C++ Build Tools。它只在构建机/CI 需要；发布包会携带预编译 helper。')
}
const devCommand = join(installation, 'Common7', 'Tools', 'VsDevCmd.bat')
await stat(devCommand)

const compile = [
  `call "${devCommand}" -arch=x64 -host_arch=x64 >nul`,
  `cl.exe /nologo /std:c++20 /EHsc /O2 /utf-8 /DUNICODE /D_UNICODE "${source}" /Fe:"${output}" /link advapi32.lib userenv.lib shell32.lib OneCoreUAP.lib`,
].join(' && ')
const result = await execFileAsync(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/c', compile], {
  cwd: nativeRoot,
  // cmd.exe 需要自行解析批处理路径的双引号；Node 默认的转义会把它们变成字面量。
  windowsVerbatimArguments: true,
})
if (result.stdout !== '') process.stdout.write(result.stdout)
if (result.stderr !== '') process.stderr.write(result.stderr)
await stat(output)
console.log(`Windows sandbox helper 已构建：${output}`)
