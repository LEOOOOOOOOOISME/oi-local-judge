// ojinteract - runs a contestant and an interactor connected by two anonymous
// pipes inside one Windows Job Object.
//
// Protocol:
//   ojinteract --interactor <exe> --contestant <exe> --input <file>
//              [--answer <file>] [--workdir <dir>] [--time-ms <n>]
//              [--wall-ms <n>] [--memory-mb <n>] [--interactor-err <file>]
//              [--contestant-err <file>]
//   interactor argv: <input> [<answer>]
//   interactor stdin: contestant stdout; interactor stdout: contestant stdin.
//   interactor exit 0 = accepted, 1 = wrong answer, other = checker error.
//
// Emits one JSON line on stdout.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>

#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

struct Options {
  std::wstring interactor;
  std::wstring contestant;
  std::wstring input;
  std::wstring answer;
  std::wstring workdir;
  std::wstring interactorErr;
  std::wstring contestantErr;
  int timeMs = 1000;
  int wallMs = 5000;
  int memoryMb = 256;
};

struct Result {
  bool ok = false;
  std::string error;
  unsigned int interactorExit = 0;
  unsigned int contestantExit = 0;
  bool timedOut = false;
  long long cpuMs = 0;
  long long wallMs = 0;
  long long peakMemKb = 0;
  std::string verdict;
};

std::string toUtf8(const std::wstring& w) {
  if (w.empty()) return {};
  int need = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0,
                                 nullptr, nullptr);
  if (need <= 0) return {};
  std::string out(static_cast<size_t>(need), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), out.data(), need,
                      nullptr, nullptr);
  return out;
}

std::string jsonEscape(const std::string& s) {
  std::string out;
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

std::string describeWin32Error(DWORD code) {
  LPWSTR buffer = nullptr;
  DWORD len = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
                                 FORMAT_MESSAGE_IGNORE_INSERTS,
                             nullptr, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
                             reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
  std::string message;
  if (len != 0 && buffer != nullptr) {
    message = toUtf8(std::wstring(buffer, len));
    while (!message.empty() &&
           (message.back() == '\n' || message.back() == '\r' || message.back() == ' ')) {
      message.pop_back();
    }
  }
  if (buffer != nullptr) LocalFree(buffer);
  return message.empty() ? "win32 error " + std::to_string(code) : message;
}

bool parseInt(const std::wstring& text, int* out) {
  if (text.empty()) return false;
  wchar_t* end = nullptr;
  long value = std::wcstol(text.c_str(), &end, 10);
  if (end == nullptr || *end != L'\0' || value <= 0 || value > 1000000000L) return false;
  *out = static_cast<int>(value);
  return true;
}

bool parseOptions(const std::vector<std::wstring>& args, Options* opt, std::string* error) {
  for (size_t i = 0; i < args.size(); ++i) {
    const std::wstring& key = args[i];
    auto next = [&](std::wstring* target) -> bool {
      if (i + 1 >= args.size()) {
        *error = "missing value for " + toUtf8(key);
        return false;
      }
      *target = args[++i];
      return true;
    };
    auto nextInt = [&](int* target) -> bool {
      std::wstring value;
      if (!next(&value)) return false;
      if (!parseInt(value, target)) {
        *error = "invalid integer for " + toUtf8(key);
        return false;
      }
      return true;
    };
    if (key == L"--interactor") {
      if (!next(&opt->interactor)) return false;
    } else if (key == L"--contestant") {
      if (!next(&opt->contestant)) return false;
    } else if (key == L"--input") {
      if (!next(&opt->input)) return false;
    } else if (key == L"--answer") {
      if (!next(&opt->answer)) return false;
    } else if (key == L"--workdir") {
      if (!next(&opt->workdir)) return false;
    } else if (key == L"--interactor-err") {
      if (!next(&opt->interactorErr)) return false;
    } else if (key == L"--contestant-err") {
      if (!next(&opt->contestantErr)) return false;
    } else if (key == L"--time-ms") {
      if (!nextInt(&opt->timeMs)) return false;
    } else if (key == L"--wall-ms") {
      if (!nextInt(&opt->wallMs)) return false;
    } else if (key == L"--memory-mb") {
      if (!nextInt(&opt->memoryMb)) return false;
    } else {
      *error = "unknown option " + toUtf8(key);
      return false;
    }
  }
  if (opt->interactor.empty() || opt->contestant.empty() || opt->input.empty()) {
    *error = "--interactor, --contestant and --input are required";
    return false;
  }
  return true;
}

std::wstring quote(const std::wstring& value) { return L"\"" + value + L"\""; }

HANDLE openInheritableFile(const std::wstring& path, SECURITY_ATTRIBUTES& sa) {
  if (path.empty()) {
    return CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                       OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  }
  return CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                     CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
}

bool createChild(const std::wstring& exe, const std::wstring& arguments,
                 const std::wstring& workdir, HANDLE stdinHandle, HANDLE stdoutHandle,
                 HANDLE stderrHandle, PROCESS_INFORMATION* pi, std::string* error) {
  std::wstring commandLine = quote(exe) + (arguments.empty() ? L"" : L" " + arguments);
  std::vector<wchar_t> buffer(commandLine.begin(), commandLine.end());
  buffer.push_back(L'\0');

  STARTUPINFOEXW siex{};
  siex.StartupInfo.cb = sizeof(siex);
  siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  siex.StartupInfo.hStdInput = stdinHandle;
  siex.StartupInfo.hStdOutput = stdoutHandle;
  siex.StartupInfo.hStdError = stderrHandle;

  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  std::vector<BYTE> storage(size);
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  DWORD flags = CREATE_SUSPENDED | CREATE_NO_WINDOW;
  HANDLE handles[3] = {stdinHandle, stdoutHandle, stderrHandle};
  if (!storage.empty() &&
      InitializeProcThreadAttributeList(reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data()),
                                        1, 0, &size)) {
    list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles,
                                  sizeof(handles), nullptr, nullptr)) {
      siex.lpAttributeList = list;
      flags |= EXTENDED_STARTUPINFO_PRESENT;
    } else {
      DeleteProcThreadAttributeList(list);
      list = nullptr;
    }
  }
  const BOOL ok = CreateProcessW(exe.c_str(), buffer.data(), nullptr, nullptr, TRUE, flags,
                                 nullptr, workdir.empty() ? nullptr : workdir.c_str(),
                                 &siex.StartupInfo, pi);
  if (list != nullptr) DeleteProcThreadAttributeList(list);
  if (!ok) {
    *error = "CreateProcessW failed for " + toUtf8(exe) + ": " +
             describeWin32Error(GetLastError());
  }
  return ok == TRUE;
}

void emit(const Result& r) {
  std::string s = "{\"ok\":";
  s += r.ok ? "true" : "false";
  if (!r.ok) {
    s += ",\"error\":\"" + jsonEscape(r.error) + "\"";
  }
  char buf[256];
  std::snprintf(buf, sizeof(buf),
                ",\"interactorExit\":%u,\"contestantExit\":%u,\"timedOut\":%s,"
                "\"cpuMs\":%lld,\"wallMs\":%lld,\"peakMemKb\":%lld",
                r.interactorExit, r.contestantExit, r.timedOut ? "true" : "false", r.cpuMs,
                r.wallMs, r.peakMemKb);
  s += buf;
  if (!r.verdict.empty()) s += ",\"verdict\":\"" + jsonEscape(r.verdict) + "\"";
  s += "}\n";
  std::fwrite(s.data(), 1, s.size(), stdout);
  std::fflush(stdout);
}

long long cpuOf(HANDLE process) {
  FILETIME creation{}, exitTime{}, kernelTime{}, userTime{};
  if (!GetProcessTimes(process, &creation, &exitTime, &kernelTime, &userTime)) return 0;
  ULARGE_INTEGER k{}, u{};
  k.LowPart = kernelTime.dwLowDateTime;
  k.HighPart = kernelTime.dwHighDateTime;
  u.LowPart = userTime.dwLowDateTime;
  u.HighPart = userTime.dwHighDateTime;
  return static_cast<long long>((k.QuadPart + u.QuadPart) / 10000ULL);
}

}  // namespace

int main() {
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::vector<std::wstring> args;
  for (int i = 1; i < argc; ++i) args.emplace_back(argv[i]);
  if (argv != nullptr) LocalFree(argv);

  Options opt;
  Result out;
  if (!parseOptions(args, &opt, &out.error)) {
    emit(out);
    return 1;
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    out.error = "CreateJobObjectW failed: " + describeWin32Error(GetLastError());
    emit(out);
    return 2;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
                                            JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
                                            JOB_OBJECT_LIMIT_PROCESS_MEMORY;
  limits.BasicLimitInformation.ActiveProcessLimit = 2;
  limits.ProcessMemoryLimit = static_cast<SIZE_T>(opt.memoryMb) * 1024ULL * 1024ULL;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    out.error = "SetInformationJobObject failed: " + describeWin32Error(GetLastError());
    CloseHandle(job);
    emit(out);
    return 3;
  }
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
  ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD |
                           JOB_OBJECT_UILIMIT_WRITECLIPBOARD |
                           JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS |
                           JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
                           JOB_OBJECT_UILIMIT_GLOBALATOMS | JOB_OBJECT_UILIMIT_DESKTOP |
                           JOB_OBJECT_UILIMIT_EXITWINDOWS;
  SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof(ui));

  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;

  HANDLE c2iRead = INVALID_HANDLE_VALUE, c2iWrite = INVALID_HANDLE_VALUE;
  HANDLE i2cRead = INVALID_HANDLE_VALUE, i2cWrite = INVALID_HANDLE_VALUE;
  if (!CreatePipe(&c2iRead, &c2iWrite, &sa, 0) || !CreatePipe(&i2cRead, &i2cWrite, &sa, 0)) {
    out.error = "CreatePipe failed: " + describeWin32Error(GetLastError());
    CloseHandle(job);
    emit(out);
    return 4;
  }
  if (!SetHandleInformation(c2iRead, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
      !SetHandleInformation(c2iWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
      !SetHandleInformation(i2cRead, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
      !SetHandleInformation(i2cWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
    out.error = "SetHandleInformation failed: " + describeWin32Error(GetLastError());
    CloseHandle(c2iRead); CloseHandle(c2iWrite); CloseHandle(i2cRead); CloseHandle(i2cWrite);
    CloseHandle(job);
    emit(out);
    return 5;
  }

  HANDLE iErr = openInheritableFile(opt.interactorErr, sa);
  HANDLE cErr = openInheritableFile(opt.contestantErr, sa);
  if (iErr == INVALID_HANDLE_VALUE || cErr == INVALID_HANDLE_VALUE) {
    out.error = "cannot open stderr files";
    CloseHandle(c2iRead); CloseHandle(c2iWrite); CloseHandle(i2cRead); CloseHandle(i2cWrite);
    CloseHandle(job);
    emit(out);
    return 6;
  }

  PROCESS_INFORMATION interactor{}, contestant{};
  std::wstring iArgs = quote(opt.input) + (opt.answer.empty() ? L"" : L" " + quote(opt.answer));
  std::string createError;
  if (!createChild(opt.interactor, iArgs, opt.workdir, c2iRead, i2cWrite, iErr, &interactor,
                   &createError)) {
    out.error = createError;
    CloseHandle(c2iRead); CloseHandle(c2iWrite); CloseHandle(i2cRead); CloseHandle(i2cWrite);
    CloseHandle(iErr); CloseHandle(cErr); CloseHandle(job);
    emit(out);
    return 7;
  }
  CloseHandle(c2iRead);
  CloseHandle(i2cWrite);
  if (!createChild(opt.contestant, L"", opt.workdir, i2cRead, c2iWrite, cErr, &contestant,
                   &createError)) {
    out.error = createError;
    TerminateProcess(interactor.hProcess, 1);
    CloseHandle(interactor.hThread); CloseHandle(interactor.hProcess);
    CloseHandle(c2iWrite); CloseHandle(i2cRead); CloseHandle(iErr); CloseHandle(cErr);
    CloseHandle(job);
    emit(out);
    return 8;
  }
  CloseHandle(c2iWrite);
  CloseHandle(i2cRead);
  CloseHandle(iErr);
  CloseHandle(cErr);

  if (!AssignProcessToJobObject(job, interactor.hProcess) ||
      !AssignProcessToJobObject(job, contestant.hProcess)) {
    out.error = "AssignProcessToJobObject failed: " + describeWin32Error(GetLastError());
    TerminateProcess(interactor.hProcess, 1);
    TerminateProcess(contestant.hProcess, 1);
    CloseHandle(interactor.hThread); CloseHandle(interactor.hProcess);
    CloseHandle(contestant.hThread); CloseHandle(contestant.hProcess);
    CloseHandle(job);
    emit(out);
    return 9;
  }

  const auto start = std::chrono::steady_clock::now();
  ResumeThread(interactor.hThread);
  ResumeThread(contestant.hThread);
  CloseHandle(interactor.hThread);
  CloseHandle(contestant.hThread);

  HANDLE waits[2] = {interactor.hProcess, contestant.hProcess};
  DWORD wall = static_cast<DWORD>(opt.wallMs);
  DWORD wait = WaitForMultipleObjects(2, waits, TRUE, wall);
  if (wait == WAIT_TIMEOUT) {
    out.timedOut = true;
    TerminateJobObject(job, 1);
    WaitForSingleObject(interactor.hProcess, 5000);
    WaitForSingleObject(contestant.hProcess, 5000);
  }
  DWORD interactorExit = 0;
  DWORD contestantExit = 0;
  GetExitCodeProcess(interactor.hProcess, &interactorExit);
  GetExitCodeProcess(contestant.hProcess, &contestantExit);
  out.interactorExit = interactorExit;
  out.contestantExit = contestantExit;
  out.wallMs = static_cast<long long>(
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start)
          .count());
  out.cpuMs = cpuOf(interactor.hProcess) + cpuOf(contestant.hProcess);

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION accounting{};
  if (QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &accounting,
                                sizeof(accounting), nullptr)) {
    out.peakMemKb = static_cast<long long>(accounting.PeakProcessMemoryUsed / 1024ULL);
  }

  if (out.timedOut) {
    out.verdict = "TLE";
  } else if (out.interactorExit == 0 && out.contestantExit == 0) {
    out.verdict = "AC";
  } else if (out.interactorExit == 1) {
    out.verdict = "WA";
  } else if (out.contestantExit != 0) {
    out.verdict = "RE";
  } else {
    out.verdict = "SE";
  }
  out.ok = true;

  CloseHandle(interactor.hProcess);
  CloseHandle(contestant.hProcess);
  CloseHandle(job);
  emit(out);
  return 0;
}
