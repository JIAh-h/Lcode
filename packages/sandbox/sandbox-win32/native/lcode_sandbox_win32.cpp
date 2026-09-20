#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <shellapi.h>

#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")

namespace {

constexpr wchar_t kProfileName[] = L"Lcode.Sandbox";
constexpr wchar_t kInternetClientCapability[] = L"internetClient";
constexpr DWORD kWorkspaceAccess = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | SYNCHRONIZE;

struct Probe {
  bool appContainer = false;
  bool workspaceAcl = false;
  bool networkPolicy = false;
  bool jobObject = false;
  std::wstring reason;
};

struct Release {
  bool released = false;
  std::wstring reason;
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
            << ",\"reason\":\"" << utf8(jsonEscape(probe.reason)) << "\"}" << std::endl;
}

void printRelease(const Release& release) {
  std::cout << "{\"released\":" << (release.released ? "true" : "false")
            << ",\"reason\":\"" << utf8(jsonEscape(release.reason)) << "\"}" << std::endl;
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

bool accessAllowedForSid(const std::wstring& path, PSID wanted) {
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD status = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                              nullptr, nullptr, &dacl, nullptr, &descriptor);
  if (status != ERROR_SUCCESS || dacl == nullptr) {
    if (descriptor != nullptr) LocalFree(descriptor);
    return false;
  }
  bool found = false;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* ace = nullptr;
    if (!GetAce(dacl, index, &ace)) continue;
    const auto* header = static_cast<ACE_HEADER*>(ace);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) continue;
    const auto* allowed = static_cast<ACCESS_ALLOWED_ACE*>(ace);
    const PSID sid = reinterpret_cast<PSID>(const_cast<DWORD*>(&allowed->SidStart));
    if (EqualSid(sid, wanted) && (allowed->Mask & kWorkspaceAccess) == kWorkspaceAccess) {
      found = true;
      break;
    }
  }
  LocalFree(descriptor);
  return found;
}

bool grantAccess(const std::wstring& path, PSID sid, bool directory, std::wstring* reason) {
  if (accessAllowedForSid(path, sid)) return true;
  PACL oldDacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD status = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                       nullptr, nullptr, &oldDacl, nullptr, &descriptor);
  if (status != ERROR_SUCCESS) {
    *reason = L"无法读取工作区 ACL: " + path + L" (" + lastError(status) + L")";
    return false;
  }

  EXPLICIT_ACCESSW access{};
  access.grfAccessPermissions = kWorkspaceAccess;
  access.grfAccessMode = GRANT_ACCESS;
  access.grfInheritance = directory ? (CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE) : NO_INHERITANCE;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  access.Trustee.ptstrName = static_cast<LPWSTR>(sid);

  PACL updatedDacl = nullptr;
  status = SetEntriesInAclW(1, &access, oldDacl, &updatedDacl);
  if (status == ERROR_SUCCESS) {
    status = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
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

bool grantWorkspace(const std::wstring& root, PSID sid, std::wstring* reason) {
  std::error_code error;
  const std::filesystem::path base(root);
  if (!std::filesystem::is_directory(base, error) || error) {
    *reason = L"工作区目录不存在或不可访问: " + root;
    return false;
  }
  if (!grantAccess(root, sid, true, reason)) return false;

  std::filesystem::recursive_directory_iterator it(base, std::filesystem::directory_options::skip_permission_denied, error);
  const std::filesystem::recursive_directory_iterator end;
  while (!error && it != end) {
    const std::filesystem::path item = it->path();
    const bool directory = it->is_directory(error);
    if (error || !grantAccess(item.wstring(), sid, directory, reason)) return false;
    it.increment(error);
  }
  if (error) {
    const std::string message = error.message();
    *reason = L"遍历工作区 ACL 时失败: " + std::wstring(message.begin(), message.end());
    return false;
  }
  return true;
}

bool revokeAccess(const std::wstring& path, PSID sid, std::wstring* reason) {
  PACL oldDacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD status = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
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
    status = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
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
  const std::filesystem::path base(root);
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
  while (!error && it != end) {
    const std::filesystem::path item = it->path();
    if (!revokeAccess(item.wstring(), sid, &result.reason)) {
      FreeSid(sid);
      return result;
    }
    it.increment(error);
  }
  if (error) {
    const std::string message = error.message();
    result.reason = L"遍历工作区 ACL 时失败: " + std::wstring(message.begin(), message.end());
    FreeSid(sid);
    return result;
  }
  FreeSid(sid);
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
  result.workspaceAcl = accessAllowedForSid(workspace, sid);
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

Probe prepare(const std::wstring& workspace, bool allowNetwork) {
  Probe result;
  std::wstring networkReason;
  if (!canConfigureNetworkCapability(&networkReason)) { result.reason = networkReason; return result; }
  PSID sid = nullptr;
  if (!getAppContainerSid(&sid, &result.reason)) return result;
  result.appContainer = true;
  if (!grantWorkspace(workspace, sid, &result.reason)) {
    FreeSid(sid);
    return result;
  }
  result.workspaceAcl = accessAllowedForSid(workspace, sid);
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

int runSandboxed(const std::wstring& workspace, bool allowNetwork, const std::vector<std::wstring>& target) {
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
  if (!grantWorkspace(workspace, sid, &reason)) {
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
                                       nullptr, workspace.c_str(), &startup.StartupInfo, &process);
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

void usage() { std::wcerr << L"Usage: lcode-sandbox-win32.exe --probe|--prepare|--revoke --workspace ROOT [--network deny|allow] | --run --workspace ROOT --network deny|allow -- COMMAND ... | --verify-job" << std::endl; }

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
  bool allowNetwork = false;
  size_t targetStart = args.size();
  for (size_t i = 1; i < args.size(); ++i) {
    if (args[i] == L"--workspace" && i + 1 < args.size()) workspace = args[++i];
    else if (args[i] == L"--network" && i + 1 < args.size()) allowNetwork = args[++i] == L"allow";
    else if (args[i] == L"--") { targetStart = i + 1; break; }
  }
  if (workspace.empty()) { usage(); return 64; }
  if (isProbe) { printProbe(probe(workspace)); return 0; }
  if (isPrepare) { printProbe(prepare(workspace, allowNetwork)); return 0; }
  if (isRevoke) { printRelease(revokeWorkspace(workspace)); return 0; }
  if (targetStart >= args.size()) { usage(); return 64; }
  return runSandboxed(workspace, allowNetwork, std::vector<std::wstring>(args.begin() + static_cast<std::ptrdiff_t>(targetStart), args.end()));
}
