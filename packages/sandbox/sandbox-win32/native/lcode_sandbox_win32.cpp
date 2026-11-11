#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <shellapi.h>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")

namespace {

constexpr wchar_t kProfileName[] = L"Lcode.Sandbox";
constexpr wchar_t kInternetClientCapability[] = L"internetClient";
/** 只读档：能读、能执行，但不能写。 */
constexpr DWORD kWorkspaceReadAccess = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | SYNCHRONIZE;
/** 工作区写档：在读的基础上加写。 */
constexpr DWORD kWorkspaceWriteAccess = kWorkspaceReadAccess | FILE_GENERIC_WRITE;

enum class SandboxMode { ReadOnly, WorkspaceWrite, FullAccess };

SandboxMode parseMode(const std::wstring& value) {
  if (value == L"read-only") return SandboxMode::ReadOnly;
  if (value == L"full-access") return SandboxMode::FullAccess;
  return SandboxMode::WorkspaceWrite;
}

DWORD modeAccessMask(SandboxMode mode) {
  return mode == SandboxMode::ReadOnly ? kWorkspaceReadAccess : kWorkspaceWriteAccess;
}

struct Probe {
  bool appContainer = false;
  bool workspaceAcl = false;
  bool networkPolicy = false;
  bool jobObject = false;
  std::wstring reason;
  std::wstring warning;
};

struct Release {
  bool released = false;
  std::wstring reason;
  std::wstring warning;
};

struct JobCheck {
  bool jobObject = false;
  std::wstring reason;
};

/**
 * `DeriveCapabilitySidsFromName` 返回的 SID 直到 CreateProcess 使用完
 * `SECURITY_CAPABILITIES` 前都必须保持有效；用 RAII 避免 allow-network
 * 分支漏掉数组或 SID 的释放。
 */
struct CapabilitySet {
  PSID* groupSids = nullptr;
  DWORD groupCount = 0;
  PSID* capabilitySids = nullptr;
  DWORD capabilityCount = 0;
  std::vector<SID_AND_ATTRIBUTES> attributes;

  ~CapabilitySet() {
    if (groupSids != nullptr) {
      for (DWORD i = 0; i < groupCount; ++i) if (groupSids[i] != nullptr) LocalFree(groupSids[i]);
      LocalFree(groupSids);
    }
    if (capabilitySids != nullptr) {
      for (DWORD i = 0; i < capabilityCount; ++i) if (capabilitySids[i] != nullptr) LocalFree(capabilitySids[i]);
      LocalFree(capabilitySids);
    }
  }
};

std::wstring lastError(DWORD error = GetLastError()) {
  LPWSTR buffer = nullptr;
  const DWORD length = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                                      nullptr, error, 0, reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
  std::wstring message = length == 0 ? L"Win32 error " + std::to_wstring(error) : std::wstring(buffer, length);
  if (buffer != nullptr) LocalFree(buffer);
  while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n')) message.pop_back();
  return message;
}

std::wstring jsonEscape(const std::wstring& value) {
  std::wstring out;
  for (const wchar_t ch : value) {
    switch (ch) {
      case L'\\': out += L"\\\\"; break;
      case L'\"': out += L"\\\""; break;
      case L'\n': out += L"\\n"; break;
      case L'\r': out += L"\\r"; break;
      case L'\t': out += L"\\t"; break;
      default: out += ch; break;
    }
  }
  return out;
}

std::string utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int bytes = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), bytes, nullptr, nullptr);
  return out;
}

void printProbe(const Probe& probe) {
  std::cout << "{\"appContainer\":" << (probe.appContainer ? "true" : "false")
            << ",\"workspaceAcl\":" << (probe.workspaceAcl ? "true" : "false")
            << ",\"networkPolicy\":" << (probe.networkPolicy ? "true" : "false")
            << ",\"jobObject\":" << (probe.jobObject ? "true" : "false")
            << ",\"reason\":\"" << utf8(jsonEscape(probe.reason)) << "\"";
  if (!probe.warning.empty()) std::cout << ",\"warning\":\"" << utf8(jsonEscape(probe.warning)) << "\"";
  std::cout << "}" << std::endl;
}

void printRelease(const Release& release) {
  std::cout << "{\"released\":" << (release.released ? "true" : "false")
            << ",\"reason\":\"" << utf8(jsonEscape(release.reason)) << "\"";
  if (!release.warning.empty()) std::cout << ",\"warning\":\"" << utf8(jsonEscape(release.warning)) << "\"";
  std::cout << "}" << std::endl;
}

void printJobCheck(const JobCheck& check) {
  std::cout << "{\"jobObject\":" << (check.jobObject ? "true" : "false")
            << ",\"reason\":\"" << utf8(jsonEscape(check.reason)) << "\"}" << std::endl;
}

bool getAppContainerSid(PSID* sid, std::wstring* reason) {
  HRESULT created = CreateAppContainerProfile(kProfileName, L"Lcode Sandbox", L"Lcode managed AppContainer", nullptr, 0, sid);
  if (SUCCEEDED(created)) return true;
  if (created != HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
    *reason = L"无法创建 AppContainer profile: " + lastError(HRESULT_CODE(created));
    return false;
  }
  const HRESULT derived = DeriveAppContainerSidFromAppContainerName(kProfileName, sid);
  if (FAILED(derived)) {
    *reason = L"无法读取 AppContainer SID: " + lastError(HRESULT_CODE(derived));
    return false;
  }
  return true;
}

bool addInternetClientCapability(CapabilitySet* set, std::wstring* reason) {
  const BOOL result = DeriveCapabilitySidsFromName(
      kInternetClientCapability,
      &set->groupSids, &set->groupCount,
      &set->capabilitySids, &set->capabilityCount);
  if (!result || set->capabilityCount == 0 || set->capabilitySids == nullptr) {
    *reason = L"无法派生 internetClient capability SID: " + lastError();
    return false;
  }
  set->attributes.reserve(set->capabilityCount);
  for (DWORD i = 0; i < set->capabilityCount; ++i) {
    SID_AND_ATTRIBUTES attribute{};
    attribute.Sid = set->capabilitySids[i];
    attribute.Attributes = SE_GROUP_ENABLED;
    set->attributes.push_back(attribute);
  }
  return true;
}

bool canConfigureNetworkCapability(std::wstring* reason) {
  CapabilitySet capability;
  return addInternetClientCapability(&capability, reason);
}

/**
 * Win32 安全 API 与 std::filesystem 默认受 MAX_PATH(260) 限制；pnpm 的
 * node_modules 嵌套路径很容易超过它。统一加 `\\?\` 前缀走长路径分支。
 */
std::wstring longPath(const std::wstring& input) {
  // `\\?\` 前缀会跳过路径规范化：必须先把正斜杠统一成反斜杠，否则会被当成非法路径
  std::wstring path = input;
  for (auto& ch : path) if (ch == L'/') ch = L'\\';
  if (path.size() >= 4 && path.compare(0, 4, L"\\\\?\\") == 0) return path;
  if (path.size() >= 2 && path[0] == L'\\' && path[1] == L'\\') return L"\\\\?\\UNC\\" + path.substr(2);
  if (path.size() >= 2 && path[1] == L':') return L"\\\\?\\" + path;
  return path;
}

bool accessMaskForSid(const std::wstring& path, PSID wanted, DWORD* foundMask) {
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const std::wstring target = longPath(path);
  const DWORD status = GetNamedSecurityInfoW(target.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                              nullptr, nullptr, &dacl, nullptr, &descriptor);
  if (status != ERROR_SUCCESS || dacl == nullptr) {
    if (descriptor != nullptr) LocalFree(descriptor);
    return false;
  }
  bool found = false;
  DWORD mask = 0;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* ace = nullptr;
    if (!GetAce(dacl, index, &ace)) continue;
    const auto* header = static_cast<ACE_HEADER*>(ace);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) continue;
    const auto* allowed = static_cast<ACCESS_ALLOWED_ACE*>(ace);
    const PSID sid = reinterpret_cast<PSID>(const_cast<DWORD*>(&allowed->SidStart));
    if (!EqualSid(sid, wanted)) continue;
    mask |= allowed->Mask;
    found = true;
  }
  LocalFree(descriptor);
  if (found) *foundMask = mask;
  return found;
}

bool accessAllowedForSid(const std::wstring& path, PSID wanted, DWORD wantedMask) {
  DWORD current = 0;
  return accessMaskForSid(path, wanted, &current) && (current & wantedMask) == wantedMask;
}

bool grantAccess(const std::wstring& path, PSID sid, bool directory, DWORD mask, bool tightenReadOnly, std::wstring* reason) {
  DWORD current = 0;
  const bool has = accessMaskForSid(path, sid, &current);
  // 只读档必须确认**没有写位**：已有读权限不代表已经从 workspace-write 降级。
  if (has && (current & mask) == mask && (!tightenReadOnly || (current & FILE_GENERIC_WRITE) == 0)) return true;
  PACL oldDacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const std::wstring target = longPath(path);
  DWORD status = GetNamedSecurityInfoW(target.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                       nullptr, nullptr, &oldDacl, nullptr, &descriptor);
  if (status != ERROR_SUCCESS) {
    *reason = L"无法读取工作区 ACL: " + path + L" (" + lastError(status) + L")";
    return false;
  }

  EXPLICIT_ACCESSW access{};
  access.grfAccessPermissions = mask;
  // SET_ACCESS：从 workspace-write 切到 read-only 时必须**降级**已有 ACE，
  // 只做 GRANT_ACCESS 会把写权限留在原处，只读档名存实亡。
  access.grfAccessMode = SET_ACCESS;
  access.grfInheritance = directory ? (CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE) : NO_INHERITANCE;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  access.Trustee.ptstrName = static_cast<LPWSTR>(sid);

  PACL updatedDacl = nullptr;
  status = SetEntriesInAclW(1, &access, oldDacl, &updatedDacl);
  if (status == ERROR_SUCCESS) {
    status = SetNamedSecurityInfoW(const_cast<LPWSTR>(target.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                   nullptr, nullptr, updatedDacl, nullptr);
  }
  if (updatedDacl != nullptr) LocalFree(updatedDacl);
  if (descriptor != nullptr) LocalFree(descriptor);
  if (status != ERROR_SUCCESS) {
    *reason = L"无法授予工作区 ACL: " + path + L" (" + lastError(status) + L")";
    return false;
  }
  return true;
}

bool grantWorkspace(const std::wstring& root, PSID sid, SandboxMode mode, std::wstring* reason, std::wstring* warning = nullptr) {
  if (mode == SandboxMode::FullAccess) return true; // 完全访问不设文件边界
  const DWORD mask = modeAccessMask(mode);
  const bool tightenReadOnly = mode == SandboxMode::ReadOnly;
  std::error_code error;
  const std::filesystem::path base(longPath(root));
  if (!std::filesystem::is_directory(base, error) || error) {
    *reason = L"工作区目录不存在或不可访问: " + root;
    return false;
  }
  if (!grantAccess(root, sid, true, mask, tightenReadOnly, reason)) return false;

  std::filesystem::recursive_directory_iterator it(base, std::filesystem::directory_options::skip_permission_denied, error);
  const std::filesystem::recursive_directory_iterator end;
  std::wstring firstSkipped;
  size_t skipped = 0;
  while (!error && it != end) {
    const std::filesystem::path item = it->path();
    bool directory = it->is_directory(error);
    if (error) {
      /*
       * 悬空的重解析点（pnpm 删包后留下的 symlink/junction）读不到目标：
       * 它没有可写的实体，任何档位都直接跳过。其它读不出类型的项仍按原语义处理：
       * workspace-write 尽力而为，只读档 fail-closed。
       */
      const std::wstring attributesPath = longPath(item.wstring());
      const DWORD attributes = GetFileAttributesW(attributesPath.c_str());
      const bool danglingReparse = attributes != INVALID_FILE_ATTRIBUTES
        && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
      error.clear();
      if (!danglingReparse && tightenReadOnly) {
        *reason = L"无法读取工作区项: " + item.wstring();
        return false;
      }
      if (danglingReparse) {
        if (skipped == 0) firstSkipped = L"悬空重解析点: " + item.wstring();
        ++skipped;
        it.increment(error);
        continue;
      }
      directory = false;
    }
    std::wstring itemReason;
    if (!grantAccess(item.wstring(), sid, directory, mask, tightenReadOnly, &itemReason)) {
      /*
       * workspace-write 下个别对象无法授予（属主是别的沙箱账号、没有改 DACL 的权限）
       * 不该拖垮整个工作区：跳过并降级为警告，该子树在沙箱内保持不可写。
       * 只读档相反——收紧不彻底就是安全漏洞，必须 fail-closed。
       */
      if (tightenReadOnly) {
        *reason = itemReason;
        return false;
      }
      if (skipped == 0) firstSkipped = itemReason;
      ++skipped;
    }
    it.increment(error);
  }
  if (error) {
    const std::string message = error.message();
    const std::wstring traversed = L"遍历工作区 ACL 时中断: " + std::wstring(message.begin(), message.end());
    if (tightenReadOnly) {
      *reason = traversed;
      return false;
    }
    // 部分授予只会少给权限（更严格），不阻断启动
    if (skipped == 0) firstSkipped = traversed;
    ++skipped;
    error.clear();
  }
  if (skipped > 0 && warning != nullptr) {
    *warning = L"有 " + std::to_wstring(skipped) + L" 个对象无法授予 ACL，已跳过（该部分在沙箱内不可写）：" + firstSkipped;
  }
  return true;
}

bool revokeAccess(const std::wstring& path, PSID sid, std::wstring* reason) {
  PACL oldDacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const std::wstring target = longPath(path);
  DWORD status = GetNamedSecurityInfoW(target.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                       nullptr, nullptr, &oldDacl, nullptr, &descriptor);
  if (status != ERROR_SUCCESS) {
    *reason = L"无法读取工作区 ACL: " + path + L" (" + lastError(status) + L")";
    return false;
  }

  EXPLICIT_ACCESSW access{};
  access.grfAccessMode = REVOKE_ACCESS;
  access.grfInheritance = NO_INHERITANCE;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  access.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  PACL updatedDacl = nullptr;
  status = SetEntriesInAclW(1, &access, oldDacl, &updatedDacl);
  if (status == ERROR_SUCCESS) {
    status = SetNamedSecurityInfoW(const_cast<LPWSTR>(target.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                   nullptr, nullptr, updatedDacl, nullptr);
  }
  if (updatedDacl != nullptr) LocalFree(updatedDacl);
  if (descriptor != nullptr) LocalFree(descriptor);
  if (status != ERROR_SUCCESS) {
    *reason = L"无法撤销工作区 ACL: " + path + L" (" + lastError(status) + L")";
    return false;
  }
  return true;
}

Release revokeWorkspace(const std::wstring& root) {
  Release result;
  PSID sid = nullptr;
  if (!getAppContainerSid(&sid, &result.reason)) return result;
  std::error_code error;
  const std::filesystem::path base(longPath(root));
  if (!std::filesystem::is_directory(base, error) || error) {
    result.reason = L"工作区目录不存在或不可访问: " + root;
    FreeSid(sid);
    return result;
  }
  if (!revokeAccess(root, sid, &result.reason)) {
    FreeSid(sid);
    return result;
  }
  std::filesystem::recursive_directory_iterator it(base, std::filesystem::directory_options::skip_permission_denied, error);
  const std::filesystem::recursive_directory_iterator end;
  std::wstring firstSkipped;
  size_t skipped = 0;
  while (!error && it != end) {
    const std::filesystem::path item = it->path();
    std::wstring itemReason;
    if (!revokeAccess(item.wstring(), sid, &itemReason)) {
      // 撤销同样是尽力而为：个别对象失败不能掩盖“根已撤销”的事实，但要如实报告。
      if (skipped == 0) firstSkipped = itemReason;
      ++skipped;
    }
    it.increment(error);
  }
  if (error) {
    const std::string message = error.message();
    const std::wstring traversed = L"遍历工作区 ACL 时中断: " + std::wstring(message.begin(), message.end());
    if (skipped == 0) firstSkipped = traversed;
    ++skipped;
    error.clear();
  }
  FreeSid(sid);
  if (skipped > 0) {
    result.warning = L"有 " + std::to_wstring(skipped) + L" 个对象无法撤销 ACL：" + firstSkipped;
  }
  result.released = true;
  return result;
}

bool canCreateJob(std::wstring* reason) {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    *reason = L"无法创建 Job Object: " + lastError();
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  const bool ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE;
  if (!ok) *reason = L"无法设置 Job Object: " + lastError();
  CloseHandle(job);
  return ok;
}

JobCheck verifyJobObject() {
  JobCheck result;
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    result.reason = L"无法创建 Job Object: " + lastError();
    return result;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    result.reason = L"无法设置 Job Object: " + lastError();
    CloseHandle(job);
    return result;
  }

  std::wstring executable(MAX_PATH, L'\0');
  const DWORD executableLength = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
  if (executableLength == 0 || executableLength == executable.size()) {
    result.reason = L"无法读取 helper 路径: " + lastError();
    CloseHandle(job);
    return result;
  }
  executable.resize(executableLength);
  std::wstring commandLine = L"\"" + executable + L"\" --job-child";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable.c_str(), commandLine.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                      nullptr, nullptr, &startup, &process)) {
    result.reason = L"无法启动 Job 验证子进程: " + lastError();
    CloseHandle(job);
    return result;
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    result.reason = L"无法把验证子进程加入 Job Object: " + lastError();
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    return result;
  }
  ResumeThread(process.hThread);
  Sleep(150);
  if (WaitForSingleObject(process.hProcess, 0) == WAIT_OBJECT_0) {
    result.reason = L"Job 验证子进程意外提前退出";
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    return result;
  }
  CloseHandle(job);
  if (WaitForSingleObject(process.hProcess, 5'000) != WAIT_OBJECT_0) {
    result.reason = L"关闭 Job Object 后验证子进程仍未退出";
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return result;
  }
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  result.jobObject = true;
  return result;
}

Probe probe(const std::wstring& workspace) {
  Probe result;
  PSID sid = nullptr;
  if (!getAppContainerSid(&sid, &result.reason)) return result;
  result.appContainer = true;
  // 只读 ACL 已授予即视为“Provider 就绪”；写权限在 prepare 时按档位升级。
  result.workspaceAcl = accessAllowedForSid(workspace, sid, kWorkspaceReadAccess);
  std::wstring networkReason;
  result.networkPolicy = canConfigureNetworkCapability(&networkReason);
  std::wstring jobReason;
  result.jobObject = canCreateJob(&jobReason);
  if (!result.networkPolicy) result.reason = networkReason;
  else if (!result.jobObject) result.reason = jobReason;
  else if (!result.workspaceAcl) result.reason = L"该工作区尚未授予 Lcode AppContainer ACL；首次获批执行时会精确授予。";
  FreeSid(sid);
  return result;
}

Probe prepare(const std::wstring& workspace, bool allowNetwork, SandboxMode mode) {
  Probe result;
  std::wstring networkReason;
  if (!canConfigureNetworkCapability(&networkReason)) { result.reason = networkReason; return result; }
  PSID sid = nullptr;
  if (!getAppContainerSid(&sid, &result.reason)) return result;
  result.appContainer = true;
  if (!grantWorkspace(workspace, sid, mode, &result.reason, &result.warning)) {
    FreeSid(sid);
    return result;
  }
  result.workspaceAcl = mode == SandboxMode::FullAccess
    ? true
    : accessAllowedForSid(workspace, sid, modeAccessMask(mode));
  result.networkPolicy = true;
  std::wstring jobReason;
  result.jobObject = canCreateJob(&jobReason);
  if (!result.jobObject) result.reason = jobReason;
  FreeSid(sid);
  return result;
}

std::wstring quote(const std::wstring& arg) {
  if (arg.find_first_of(L" \t\"") == std::wstring::npos) return arg;
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (const wchar_t ch : arg) {
    if (ch == L'\\') { ++slashes; continue; }
    if (ch == L'\"') out.append(slashes * 2 + 1, L'\\');
    else out.append(slashes, L'\\');
    slashes = 0;
    out += ch;
  }
  out.append(slashes * 2, L'\\');
  out += L'\"';
  return out;
}

/**
 * 完全访问：不套 AppContainer/ACL，只保留 Job Object 做进程树回收。
 * 文件与网络边界由策略/审批决定，而不是 OS 沙箱。
 */
int runWithJobOnly(const std::wstring& workspace, const wchar_t* environment, const std::vector<std::wstring>& target) {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job == nullptr || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    std::wcerr << L"无法创建受控 Job Object: " << lastError() << std::endl;
    if (job != nullptr) CloseHandle(job);
    return 7;
  }

  std::wstring commandLine;
  for (const auto& arg : target) {
    if (!commandLine.empty()) commandLine += L' ';
    commandLine += quote(arg);
  }
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  const BOOL launched = CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, TRUE,
                                       CREATE_SUSPENDED, const_cast<LPVOID>(static_cast<const void*>(environment)), workspace.c_str(), &startup, &process);
  if (!launched) {
    std::wcerr << L"无法启动目标程序: " << lastError() << std::endl;
    CloseHandle(job);
    return 10;
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    std::wcerr << L"无法把目标程序加入 Job Object: " << lastError() << std::endl;
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    CloseHandle(job);
    return 11;
  }
  ResumeThread(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exitCode = 1;
  GetExitCodeProcess(process.hProcess, &exitCode);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CloseHandle(job);
  return static_cast<int>(exitCode);
}

int runSandboxed(const std::wstring& workspace, bool allowNetwork, SandboxMode mode, const wchar_t* environment, const std::vector<std::wstring>& target) {
  if (mode == SandboxMode::FullAccess) return runWithJobOnly(workspace, environment, target);
  CapabilitySet networkCapabilities;
  std::wstring networkReason;
  if (allowNetwork && !addInternetClientCapability(&networkCapabilities, &networkReason)) {
    std::wcerr << networkReason << std::endl;
    return 4;
  }
  PSID sid = nullptr;
  std::wstring reason;
  if (!getAppContainerSid(&sid, &reason)) {
    std::wcerr << reason << std::endl;
    return 5;
  }
  if (!grantWorkspace(workspace, sid, mode, &reason)) {
    std::wcerr << reason << std::endl;
    FreeSid(sid);
    return 6;
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job == nullptr || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    std::wcerr << L"无法创建受控 Job Object: " << lastError() << std::endl;
    if (job != nullptr) CloseHandle(job);
    FreeSid(sid);
    return 7;
  }

  SIZE_T attributesBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributesBytes);
  std::vector<BYTE> attributeStorage(attributesBytes);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributesBytes)) {
    std::wcerr << L"无法初始化 AppContainer 属性: " << lastError() << std::endl;
    CloseHandle(job); FreeSid(sid); return 8;
  }
  SECURITY_CAPABILITIES security{};
  security.AppContainerSid = sid;
  if (allowNetwork) {
    security.Capabilities = networkCapabilities.attributes.data();
    security.CapabilityCount = static_cast<DWORD>(networkCapabilities.attributes.size());
  }
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security, sizeof(security), nullptr, nullptr)) {
    std::wcerr << L"无法设置 AppContainer capability 属性: " << lastError() << std::endl;
    DeleteProcThreadAttributeList(attributes); CloseHandle(job); FreeSid(sid); return 9;
  }

  std::wstring commandLine;
  for (const auto& arg : target) {
    if (!commandLine.empty()) commandLine += L' ';
    commandLine += quote(arg);
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  const BOOL launched = CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, TRUE,
                                       EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
                                       const_cast<LPVOID>(static_cast<const void*>(environment)), workspace.c_str(), &startup.StartupInfo, &process);
  if (!launched) {
    std::wcerr << L"无法在 AppContainer 中启动目标程序: " << lastError() << std::endl;
    DeleteProcThreadAttributeList(attributes); CloseHandle(job); FreeSid(sid); return 10;
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    std::wcerr << L"无法把目标程序加入 Job Object: " << lastError() << std::endl;
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    DeleteProcThreadAttributeList(attributes); CloseHandle(job); FreeSid(sid); return 11;
  }
  ResumeThread(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exitCode = 1;
  GetExitCodeProcess(process.hProcess, &exitCode);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  DeleteProcThreadAttributeList(attributes);
  CloseHandle(job); // KILL_ON_JOB_CLOSE 清理仍存活的子进程。
  FreeSid(sid);
  return static_cast<int>(exitCode);
}

void usage() { std::wcerr << L"Usage: lcode-sandbox-win32.exe --probe|--prepare|--revoke --workspace ROOT [--network deny|allow] [--mode read-only|workspace-write|full-access] | --run --workspace ROOT --network deny|allow --mode MODE -- COMMAND ... | --verify-job" << std::endl; }

} // namespace

int wmain() {
  int argc = 0;
  LPWSTR* values = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (values == nullptr) return 64;
  std::vector<std::wstring> args(values + 1, values + argc);
  LocalFree(values);
  if (args.empty()) { usage(); return 64; }

  bool isProbe = args[0] == L"--probe";
  bool isPrepare = args[0] == L"--prepare";
  bool isRevoke = args[0] == L"--revoke";
  bool isRun = args[0] == L"--run";
  bool isVerifyJob = args[0] == L"--verify-job";
  bool isJobChild = args[0] == L"--job-child";
  if (isJobChild) {
    Sleep(30'000);
    return 0;
  }
  if (isVerifyJob) {
    printJobCheck(verifyJobObject());
    return 0;
  }
  if (!isProbe && !isPrepare && !isRevoke && !isRun) { usage(); return 64; }
  std::wstring workspace;
  std::wstring modeValue = L"workspace-write";
  bool allowNetwork = false;
  /*
   * 目标进程的环境块（docs/09 §3.2.6）。
   *
   * helper 由 Electron 主进程启动，继承的是**主进程**的精简 PATH——
   * 用户安装的 node / pnpm / git 往往在 shell 的 PATH 里而不在这里。
   * 传 nullptr 等于继承 helper 环境，于是沙箱里 `node` "不是内部或外部命令"。
   * 宿主把 `process.env` 写成 UTF-16 环境块文件传进来（--env-file），这里读出。
   * 不传则维持旧行为（继承 helper 环境）。
   */
  std::wstring envFile;
  size_t targetStart = args.size();
  for (size_t i = 1; i < args.size(); ++i) {
    if (args[i] == L"--workspace" && i + 1 < args.size()) workspace = args[++i];
    else if (args[i] == L"--network" && i + 1 < args.size()) allowNetwork = args[++i] == L"allow";
    else if (args[i] == L"--mode" && i + 1 < args.size()) modeValue = args[++i];
    else if (args[i] == L"--env-file" && i + 1 < args.size()) envFile = args[++i];
    else if (args[i] == L"--") { targetStart = i + 1; break; }
  }
  if (workspace.empty()) { usage(); return 64; }
  // 读环境块文件（UTF-16LE，标准 CreateProcessW 格式：KEY=VALUE\0 … \0\0）
  std::wstring envBlock;
  if (!envFile.empty()) {
    std::ifstream in(envFile.c_str(), std::ios::binary);
    if (in) {
      std::ostringstream ss;
      ss << in.rdbuf();
      const std::string raw = ss.str();
      if (raw.size() >= 2 && static_cast<unsigned char>(raw[0]) == 0xFF && static_cast<unsigned char>(raw[1]) == 0xFE) {
        envBlock.assign(reinterpret_cast<const wchar_t*>(raw.data() + 2), (raw.size() - 2) / sizeof(wchar_t));
      }
    }
    // 读不出就留空：保持旧行为（继承 helper 环境），不因缺文件而拒绝执行
  }
  if (!envBlock.empty()) {
    /*
     * 用**注册表**的机器+用户 PATH 覆盖 env 块里的 PATH（docs/09 §3.2.6）。
     *
     * 为什么：宿主传来的 env 是 Electron 主进程的 PATH——它常常精简到没有
     * 用户装的 node / pnpm / git。注册表的 PATH 才是"用户 shell 会看到的那个"。
     * 最小块实验也证明：机器 PATH 存在时，沙箱里的 node / pnpm 都能用。
     *
     * 失败就保留 env 原样：注册表读不到时执行仍可行，只是 PATH 可能不全。
     */
    std::wstring machinePath;
    std::wstring userPath;
    /*
     * 注册表 PATH 是 **REG_EXPAND_SZ**（含 `%JAVA_HOME%` 这类未展开变量）。
     * 两个坑，都实测踩过：
     * 1. 用 RRF_RT_REG_SZ 读会把未展开字面量混进环境块，CreateProcessW 直接
     *    失败（exit 10）。必须用 RRF_RT_REG_EXPAND_SZ 让系统展开。
     * 2. 展开后的实际长度比首次查询大，所以两段式读取（先问大小、再取值）
     *    要按**返回的 got** 裁剪，不能复用首次的 size。
     */
    const auto readPathValue = [](HKEY root, const wchar_t* subkey) -> std::wstring {
      DWORD size = 0;
      if (RegGetValueW(root, subkey, L"Path", RRF_RT_REG_EXPAND_SZ, nullptr, nullptr, &size) != ERROR_SUCCESS || size == 0) return L"";
      // 多留一个 wchar_t 的余量，防止展开后超长截断
      std::vector<wchar_t> buffer(size / sizeof(wchar_t) + 256, L'\0');
      DWORD got = static_cast<DWORD>(buffer.size() * sizeof(wchar_t));
      if (RegGetValueW(root, subkey, L"Path", RRF_RT_REG_EXPAND_SZ, nullptr, buffer.data(), &got) != ERROR_SUCCESS) return L"";
      const size_t chars = got / sizeof(wchar_t);
      return std::wstring(buffer.data(), wcsnlen(buffer.data(), chars));
    };
    machinePath = readPathValue(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
    userPath = readPathValue(HKEY_CURRENT_USER, L"Environment");
    if (!machinePath.empty() || !userPath.empty()) {
      std::wstring combined = machinePath;
      if (!userPath.empty()) {
        if (!combined.empty() && combined.back() != L';') combined += L';';
        combined += userPath;
      }
      // 在 env 块里就地替换 PATH 条目
      std::wstring rebuilt;
      size_t pos = 0;
      bool replaced = false;
      while (pos < envBlock.size()) {
        size_t end = envBlock.find(L'\0', pos);
        if (end == std::wstring::npos) break;
        const std::wstring entry = envBlock.substr(pos, end - pos);
        const size_t eq = entry.find(L'=');
        if (!replaced && eq != std::wstring::npos && _wcsicmp(entry.substr(0, eq).c_str(), L"PATH") == 0) {
          rebuilt += L"PATH=" + combined + L'\0';
          replaced = true;
        } else {
          rebuilt += entry + L'\0';
        }
        pos = end + 1;
      }
      rebuilt += L'\0';
      envBlock = rebuilt;
    }
  }
  const SandboxMode mode = parseMode(modeValue);
  if (isProbe) { printProbe(probe(workspace)); return 0; }
  if (isPrepare) { printProbe(prepare(workspace, allowNetwork, mode)); return 0; }
  if (isRevoke) { printRelease(revokeWorkspace(workspace)); return 0; }
  if (targetStart >= args.size()) { usage(); return 64; }
  return runSandboxed(workspace, allowNetwork, mode,
                      envBlock.empty() ? nullptr : envBlock.c_str(),
                      std::vector<std::wstring>(args.begin() + static_cast<std::ptrdiff_t>(targetStart), args.end()));
}
