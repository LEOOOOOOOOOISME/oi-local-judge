// ojrunner - Windows Job Object sandboxed process runner (Phase 0 prototype).
//
// Usage:
//   ojrunner.exe --exe <path> [--workdir <dir>] [--time-ms <n>] [--wall-ms <n>]
//                [--memory-mb <n>] [--process-limit <n>]
//                [--input <file>] [--output <file>] [--stderr <file>]
//
// Emits exactly one JSON line on stdout:
//   {"exitCode":0,"cpuMs":0,"wallMs":0,"peakMemKb":0,"timedOut":false,"oom":false,
//    "signal":0,"stdoutBytes":0,"stderrBytes":0,"pid":1234,"ok":true}
// Extra fields appear only when relevant: "error"/"ok":false on internal
// failures, "reapMs" when the wall-clock watchdog had to kill the child, and
// "killNote" when termination needed a fallback or did not complete.
//
// Notes:
//  * The child is created suspended, assigned to the job, then resumed, so no
//    work happens outside the sandbox limits.
//  * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE guarantees the whole job dies if this
//    runner crashes or is killed.
//  * exitCode is the raw 32-bit process exit code (NTSTATUS values such as
//    0xC0000017 remain visible in the unsigned value; killed runs report 1).
//  * "signal" is a POSIX-style approximation of common NTSTATUS crash codes
//    (SIGSEGV=11, SIGFPE=8, SIGILL=4, SIGABRT=6); 0 when the process exited
//    normally or was terminated by this runner.
//  * "oom" is set when the job memory limit was plausibly hit: peak memory
//    reached >=90% of the limit, the process died with STATUS_NO_MEMORY /
//    STATUS_COMMITMENT_LIMIT, or stderr carries a bad_alloc/commit failure
//    signature. The job memory limit makes allocations fail rather than
//    killing the process, so peak memory alone is not sufficient. This is
//    checked even when the wall-clock watchdog fired, because the allocation
//    failure/CRT abort path can stall under memory pressure.
//  * Set OIJ_RUNNER_DEBUG=1 to get a diagnostic trace on the runner's own
//    stderr (never mixed into the JSON line on stdout).


#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <string>
#include <vector>

namespace {

constexpr DWORD kStatusNoMemory = 0xC0000017u;
constexpr DWORD kStatusCommitmentLimit = 0xC000012Du;
constexpr DWORD kStatusIllegalInstruction = 0xC000001Du;
constexpr DWORD kStatusStackOverflow = 0xC00000FDu;
constexpr DWORD kStatusAccessViolation = 0xC0000005u;
constexpr DWORD kStatusInPageError = 0xC0000006u;
constexpr DWORD kStatusIntegerDivideByZero = 0xC0000094u;
constexpr DWORD kStatusArrayBoundsExceeded = 0xC000008Cu;
constexpr DWORD kStatusStackBufferOverrun = 0xC0000409u;

struct Options {
  std::wstring exe;
  std::wstring workdir;
  std::wstring input;
  std::wstring output;
  std::wstring stderrPath;
  int timeMs = 1000;
  int wallMs = 3000;
  int memoryMb = 256;
  int processLimit = 1;
  // Fail instead of silently running as the service account when the server
  // requires isolation. Credentials themselves arrive through the environment
  // (never argv, which is visible to other users).
  bool workerRequired = false;
};

struct WorkerCredentials {
  std::wstring user;
  std::wstring password;
};

std::wstring readEnvValue(const wchar_t* name) {
  DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
  if (size == 0) return std::wstring();
  std::wstring value(size, L'\0');
  DWORD written = GetEnvironmentVariableW(name, value.data(), size);
  if (written == 0) return std::wstring();
  value.resize(written);
  return value;
}

WorkerCredentials readWorkerCredentials() {
  WorkerCredentials credentials;
  credentials.user = readEnvValue(L"OIJ_RUNNER_WORKER_USER");
  credentials.password = readEnvValue(L"OIJ_RUNNER_WORKER_PASSWORD");
  return credentials;
}

/**
 * Minimal environment for the isolated worker process. The runner itself holds
 * the worker password, so passing its own environment block would leak the
 * credential into contestant code.
 */
std::wstring buildWorkerEnvironment(const std::wstring& workdir) {
  const wchar_t* safeNames[] = {
      L"SystemRoot", L"SystemDrive", L"windir", L"COMSPEC", L"PATH",
      L"PATHEXT",    L"NUMBER_OF_PROCESSORS", L"PROCESSOR_ARCHITECTURE",
      L"OS",
  };
  std::wstring block;
  for (const wchar_t* name : safeNames) {
    const std::wstring value = readEnvValue(name);
    if (value.empty()) continue;
    block.append(name);
    block.push_back(L'=');
    block.append(value);
    block.push_back(L'\0');
  }
  if (!workdir.empty()) {
    block.append(L"TEMP=");
    block.append(workdir);
    block.push_back(L'\0');
    block.append(L"TMP=");
    block.append(workdir);
    block.push_back(L'\0');
  }
  // Environment blocks are double-NUL terminated.
  block.push_back(L'\0');
  return block;
}

struct Result {
  bool ok = false;
  std::string error;
  unsigned int exitCode = 0;
  long long cpuMs = 0;
  long long wallMs = 0;
  long long peakMemKb = 0;
  bool timedOut = false;
  bool oom = false;
  int signal = 0;
  long long stdoutBytes = 0;
  long long stderrBytes = 0;
  DWORD pid = 0;
  long long reapMs = 0;
  std::string killNote;
};

void debugTrace(const char* format, ...) {
  static const bool enabled = []() {
    const char* value = std::getenv("OIJ_RUNNER_DEBUG");
    return value != nullptr && *value != '\0' && std::strcmp(value, "0") != 0;
  }();
  if (!enabled) return;
  va_list args;
  va_start(args, format);
  std::fprintf(stderr, "[ojrunner] ");
  std::vfprintf(stderr, format, args);
  std::fprintf(stderr, "\n");
  va_end(args);
  std::fflush(stderr);
}

std::string toUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int need = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()),
                                 nullptr, 0, nullptr, nullptr);
  if (need <= 0) return std::string();
  std::string out(static_cast<size_t>(need), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), out.data(),
                      need, nullptr, nullptr);
  return out;
}

std::string jsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
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

void appendField(std::string& s, const char* key, long long value) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), ",\"%s\":%lld", key, value);
  s += buf;
}

void emitJson(const Result& r) {
  std::string s;
  s.reserve(640);
  s += "{\"exitCode\":";
  {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%u", r.exitCode);
    s += buf;
  }
  appendField(s, "cpuMs", r.cpuMs);
  appendField(s, "wallMs", r.wallMs);
  appendField(s, "peakMemKb", r.peakMemKb);
  s += ",\"timedOut\":";
  s += r.timedOut ? "true" : "false";
  s += ",\"oom\":";
  s += r.oom ? "true" : "false";
  appendField(s, "signal", r.signal);
  appendField(s, "stdoutBytes", r.stdoutBytes);
  appendField(s, "stderrBytes", r.stderrBytes);
  appendField(s, "pid", static_cast<long long>(r.pid));
  if (r.reapMs > 0) appendField(s, "reapMs", r.reapMs);
  if (!r.killNote.empty()) {
    s += ",\"killNote\":\"";
    s += jsonEscape(r.killNote);
    s += "\"";
  }
  if (r.ok) {
    s += ",\"ok\":true";
  } else {
    s += ",\"ok\":false";
    s += ",\"error\":\"";
    s += jsonEscape(r.error);
    s += "\"";
  }
  s += "}\n";
  std::fwrite(s.data(), 1, s.size(), stdout);
  std::fflush(stdout);
}

std::vector<std::wstring> splitArgs() {
  std::vector<std::wstring> args;
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (argv == nullptr) return args;
  for (int i = 1; i < argc; ++i) args.emplace_back(argv[i]);
  LocalFree(argv);
  return args;
}

bool parseInt(const std::wstring& text, int* out) {
  if (text.empty()) return false;
  wchar_t* end = nullptr;
  long value = std::wcstol(text.c_str(), &end, 10);
  if (end == nullptr || *end != L'\0') return false;
  if (value < 0 || value > 1000000000L) return false;
  *out = static_cast<int>(value);
  return true;
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
  if (message.empty()) message = "win32 error " + std::to_string(code);
  return message;
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
        *error = "invalid integer for " + toUtf8(key) + ": " + toUtf8(value);
        return false;
      }
      return true;
    };

    if (key == L"--exe") {
      if (!next(&opt->exe)) return false;
    } else if (key == L"--workdir") {
      if (!next(&opt->workdir)) return false;
    } else if (key == L"--input") {
      if (!next(&opt->input)) return false;
    } else if (key == L"--output") {
      if (!next(&opt->output)) return false;
    } else if (key == L"--stderr") {
      if (!next(&opt->stderrPath)) return false;
    } else if (key == L"--time-ms") {
      if (!nextInt(&opt->timeMs)) return false;
    } else if (key == L"--wall-ms") {
      if (!nextInt(&opt->wallMs)) return false;
    } else if (key == L"--memory-mb") {
      if (!nextInt(&opt->memoryMb)) return false;
    } else if (key == L"--process-limit") {
      if (!nextInt(&opt->processLimit)) return false;
    } else if (key == L"--worker-required") {
      opt->workerRequired = true;
    } else if (key == L"--help" || key == L"-h") {
      *error = "usage: ojrunner --exe <path> [--workdir <dir>] [--time-ms <n>] "
               "[--wall-ms <n>] [--memory-mb <n>] [--process-limit <n>] "
               "[--input <file>] [--output <file>] [--stderr <file>] "
               "[--worker-required]";
      return false;
    } else {
      *error = "unknown option " + toUtf8(key);
      return false;
    }
  }
  if (opt->exe.empty()) {
    *error = "missing required option --exe";
    return false;
  }
  if (opt->wallMs <= 0) {
    *error = "--wall-ms must be positive";
    return false;
  }
  if (opt->timeMs <= 0) {
    *error = "--time-ms must be positive";
    return false;
  }
  if (opt->memoryMb <= 0) {
    *error = "--memory-mb must be positive";
    return false;
  }
  if (opt->processLimit <= 0) {
    *error = "--process-limit must be positive";
    return false;
  }
  return true;
}

// Opens a file for the child process. Empty paths fall back to the NUL device so
// that every standard handle is a real, inheritable handle.
HANDLE openForChild(const std::wstring& path, DWORD access, DWORD disposition,
                    SECURITY_ATTRIBUTES& sa, std::string* error) {
  if (path.empty()) {
    // NUL must be opened with write access even when used as input, because
    // CreateFileW on the NUL device requires GENERIC_WRITE.
    HANDLE h = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
                           FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
      *error = "cannot open NUL device: " + describeWin32Error(GetLastError());
    }
    return h;
  }
  HANDLE h = CreateFileW(path.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                         disposition, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    *error = "cannot open " + toUtf8(path) + ": " + describeWin32Error(GetLastError());
  }
  return h;
}

long long fileSize(HANDLE h) {
  LARGE_INTEGER size{};
  if (h == nullptr || h == INVALID_HANDLE_VALUE) return 0;
  if (!GetFileSizeEx(h, &size)) return 0;
  return static_cast<long long>(size.QuadPart);
}

bool fileContainsMarker(HANDLE h, const char* needle, size_t needleLen) {
  if (h == nullptr || h == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(h, zero, nullptr, FILE_BEGIN)) return false;
  std::vector<char> buffer(65536);
  DWORD read = 0;
  if (!ReadFile(h, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
    return false;
  }
  if (read == 0) return false;
  return std::search(buffer.begin(), buffer.begin() + read, needle, needle + needleLen) !=
         buffer.begin() + read;
}

int signalForExitCode(DWORD code) {
  switch (code) {
    case kStatusAccessViolation:
    case kStatusStackOverflow:
    case kStatusInPageError:
      return 11;  // SIGSEGV
    case kStatusIntegerDivideByZero:
    case kStatusArrayBoundsExceeded:
      return 8;  // SIGFPE
    case kStatusIllegalInstruction:
      return 4;  // SIGILL
    case kStatusStackBufferOverrun:
      return 6;  // SIGABRT
    default:
      return 0;
  }
}

struct KillOutcome {
  bool jobTerminated = false;
  DWORD jobError = 0;
  bool reaped = false;
  bool fallbackUsed = false;
  DWORD fallbackError = 0;
  long long reapMs = 0;
};

KillOutcome terminateWholeJob(HANDLE job, HANDLE process) {
  KillOutcome outcome;
  const auto start = std::chrono::steady_clock::now();
  if (TerminateJobObject(job, 1u)) {
    outcome.jobTerminated = true;
  } else {
    outcome.jobError = GetLastError();
  }
  DWORD wait = WaitForSingleObject(process, 5000);
  outcome.reaped = (wait == WAIT_OBJECT_0);
  if (!outcome.reaped && process != nullptr && process != INVALID_HANDLE_VALUE) {
    // Defensive fallback: kill the root process directly too. Termination of a
    // process stuck in kernel-mode teardown can be delayed, so this is
    // best-effort and its result is reported to the caller.
    outcome.fallbackUsed = true;
    if (!TerminateProcess(process, 1u)) {
      outcome.fallbackError = GetLastError();
    }
    wait = WaitForSingleObject(process, 5000);
    outcome.reaped = (wait == WAIT_OBJECT_0);
  }
  outcome.reapMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - start)
          .count();
  return outcome;
}

long long queryActiveProcesses(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting,
                                 sizeof(accounting), nullptr)) {
    return 0;
  }
  return static_cast<long long>(accounting.ActiveProcesses);
}

int run(const Options& opt, Result* out) {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    out->error = "CreateJobObjectW failed: " + describeWin32Error(GetLastError());
    return 2;
  }

  bool jobConfigured = false;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_PROCESS_TIME | JOB_OBJECT_LIMIT_PROCESS_MEMORY |
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  // Per-plan buffer: give the wall-clock watchdog a chance to fire first.
  limits.BasicLimitInformation.PerProcessUserTimeLimit.QuadPart =
      static_cast<LONGLONG>(opt.timeMs + 1000) * 10000LL;
  limits.ProcessMemoryLimit =
      static_cast<SIZE_T>(static_cast<unsigned long long>(opt.memoryMb) * 1024ULL * 1024ULL);
  limits.BasicLimitInformation.ActiveProcessLimit = static_cast<DWORD>(opt.processLimit);
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    out->error = "SetInformationJobObject(ExtendedLimit) failed: " +
                 describeWin32Error(GetLastError());
    CloseHandle(job);
    return 3;
  }
  jobConfigured = true;

  JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
  ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD |
                           JOB_OBJECT_UILIMIT_WRITECLIPBOARD |
                           JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS |
                           JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
                           JOB_OBJECT_UILIMIT_GLOBALATOMS | JOB_OBJECT_UILIMIT_DESKTOP |
                           JOB_OBJECT_UILIMIT_EXITWINDOWS;
  // Best effort: UI restrictions are not supported on every SKU.
  SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof(ui));

  const WorkerCredentials worker = readWorkerCredentials();
  if (opt.workerRequired && (worker.user.empty() || worker.password.empty())) {
    out->error =
        "worker isolation required but OIJ_RUNNER_WORKER_USER/OIJ_RUNNER_WORKER_PASSWORD are "
        "missing (refusing to run as the service account)";
    CloseHandle(job);
    return 8;
  }
  if (worker.user.empty() != worker.password.empty()) {
    out->error =
        "OIJ_RUNNER_WORKER_USER and OIJ_RUNNER_WORKER_PASSWORD must be provided together";
    CloseHandle(job);
    return 8;
  }
  const bool workerMode = !worker.user.empty();

  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.lpSecurityDescriptor = nullptr;
  sa.bInheritHandle = TRUE;

  HANDLE hIn = INVALID_HANDLE_VALUE;
  HANDLE hOut = INVALID_HANDLE_VALUE;
  HANDLE hErr = INVALID_HANDLE_VALUE;
  std::string openError;

  hIn = openForChild(opt.input, GENERIC_READ, OPEN_EXISTING, sa, &openError);
  if (hIn == INVALID_HANDLE_VALUE) {
    out->error = openError;
    if (jobConfigured) CloseHandle(job);
    return 4;
  }
  // Output handles are opened read+write so stderr can be scanned afterwards.
  hOut = openForChild(opt.output, GENERIC_READ | GENERIC_WRITE, CREATE_ALWAYS, sa,
                      &openError);
  if (hOut == INVALID_HANDLE_VALUE) {
    out->error = openError;
    CloseHandle(hIn);
    CloseHandle(job);
    return 4;
  }
  hErr = openForChild(opt.stderrPath, GENERIC_READ | GENERIC_WRITE, CREATE_ALWAYS, sa,
                      &openError);
  if (hErr == INVALID_HANDLE_VALUE) {
    out->error = openError;
    CloseHandle(hIn);
    CloseHandle(hOut);
    CloseHandle(job);
    return 4;
  }

  std::wstring commandLine = L"\"" + opt.exe + L"\"";
  std::vector<wchar_t> commandBuffer(commandLine.begin(), commandLine.end());
  commandBuffer.push_back(L'\0');

  STARTUPINFOEXW siex{};
  siex.StartupInfo.cb = sizeof(siex);
  siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  siex.StartupInfo.hStdInput = hIn;
  siex.StartupInfo.hStdOutput = hOut;
  siex.StartupInfo.hStdError = hErr;
  PROCESS_INFORMATION pi{};

  DWORD creationFlags = CREATE_SUSPENDED | CREATE_NO_WINDOW;
  // Restrict handle inheritance to the three stdio handles. With
  // bInheritHandles=TRUE every inheritable handle of the runner leaks into the
  // child; in particular an inherited console handle can change the behaviour of
  // a crashing child's CRT teardown. PROC_THREAD_ATTRIBUTE_HANDLE_LIST narrows
  // inheritance to exactly the redirected files. Failure is fatal: falling back
  // to unrestricted inheritance would silently widen what the contestant can
  // touch.
  //
  // CreateProcessWithLogonW does not accept EXTENDED_STARTUPINFO_PRESENT (it
  // returns ERROR_INVALID_PARAMETER), so the worker path uses a plain
  // STARTUPINFOW. That API cannot be combined with an explicit handle list;
  // this limitation is reported by the worker-isolation path and is why the
  // required mode refuses to run rather than silently falling back when the
  // isolated process cannot be created.
  STARTUPINFOW plainStartup{};
  plainStartup.cb = sizeof(plainStartup);
  plainStartup.dwFlags = STARTF_USESTDHANDLES;
  plainStartup.hStdInput = hIn;
  plainStartup.hStdOutput = hOut;
  plainStartup.hStdError = hErr;
  LPSTARTUPINFOW startupInfo = &plainStartup;
  std::vector<BYTE> attributeStorage;
  LPPROC_THREAD_ATTRIBUTE_LIST attributeList = nullptr;

  if (!workerMode) {
    SIZE_T attributeSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
    if (attributeSize == 0) {
      out->error = "InitializeProcThreadAttributeList sizing failed: " +
                   describeWin32Error(GetLastError());
      CloseHandle(hIn);
      CloseHandle(hOut);
      CloseHandle(hErr);
      CloseHandle(job);
      return 9;
    }
    attributeStorage.assign(attributeSize, 0);
    attributeList =
        reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    if (!InitializeProcThreadAttributeList(attributeList, 1, 0, &attributeSize)) {
      out->error = "InitializeProcThreadAttributeList failed: " +
                   describeWin32Error(GetLastError());
      CloseHandle(hIn);
      CloseHandle(hOut);
      CloseHandle(hErr);
      CloseHandle(job);
      return 9;
    }
    HANDLE stdHandles[3] = {hIn, hOut, hErr};
    if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                   stdHandles, sizeof(stdHandles), nullptr, nullptr)) {
      out->error = "UpdateProcThreadAttribute(HANDLE_LIST) failed: " +
                   describeWin32Error(GetLastError());
      DeleteProcThreadAttributeList(attributeList);
      CloseHandle(hIn);
      CloseHandle(hOut);
      CloseHandle(hErr);
      CloseHandle(job);
      return 9;
    }
    siex.lpAttributeList = attributeList;
    creationFlags |= EXTENDED_STARTUPINFO_PRESENT;
    startupInfo = &siex.StartupInfo;
    debugTrace("using PROC_THREAD_ATTRIBUTE_HANDLE_LIST for stdio inheritance");
  }

  const wchar_t* cwd = opt.workdir.empty() ? nullptr : opt.workdir.c_str();
  const std::wstring workerEnvironment =
      workerMode ? buildWorkerEnvironment(opt.workdir) : std::wstring();
  BOOL created = FALSE;
  if (workerMode) {
    // CreateProcessWithLogonW creates the process with the worker token; the
    // environment block is minimal so the worker password in the runner's own
    // environment never reaches contestant code.
    created = CreateProcessWithLogonW(
        worker.user.c_str(), nullptr, worker.password.c_str(), LOGON_WITH_PROFILE,
        opt.exe.c_str(), commandBuffer.data(),
        creationFlags | CREATE_UNICODE_ENVIRONMENT,
        workerEnvironment.empty()
            ? nullptr
            : const_cast<wchar_t*>(workerEnvironment.c_str()),
        cwd, startupInfo, &pi);
    if (!created) {
      const DWORD code = GetLastError();
      out->error = "CreateProcessWithLogonW failed for " + toUtf8(opt.exe) + ": " +
                   describeWin32Error(code) + " (code " + std::to_string(code) + ")";
    }
  } else {
    created = CreateProcessW(opt.exe.c_str(), commandBuffer.data(), nullptr, nullptr, TRUE,
                             creationFlags, nullptr, cwd, startupInfo, &pi);
    if (!created) {
      out->error = "CreateProcessW failed for " + toUtf8(opt.exe) + ": " +
                   describeWin32Error(GetLastError());
    }
  }
  if (attributeList != nullptr) {
    DeleteProcThreadAttributeList(attributeList);
  }
  if (!created) {
    CloseHandle(hIn);
    CloseHandle(hOut);
    CloseHandle(hErr);
    CloseHandle(job);
    return 5;
  }
  out->pid = pi.dwProcessId;

  if (!AssignProcessToJobObject(job, pi.hProcess)) {
    DWORD code = GetLastError();
    out->error = "AssignProcessToJobObject failed: " + describeWin32Error(code) + " (code " +
                 std::to_string(code) + ")";
    TerminateProcess(pi.hProcess, 1u);
    WaitForSingleObject(pi.hProcess, 5000);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(hIn);
    CloseHandle(hOut);
    CloseHandle(hErr);
    CloseHandle(job);
    return 6;
  }

  const auto start = std::chrono::steady_clock::now();
  if (ResumeThread(pi.hThread) == static_cast<DWORD>(-1)) {
    out->error = "ResumeThread failed: " + describeWin32Error(GetLastError());
    terminateWholeJob(job, pi.hProcess);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(hIn);
    CloseHandle(hOut);
    CloseHandle(hErr);
    CloseHandle(job);
    return 7;
  }

  DWORD waitResult = WaitForSingleObject(pi.hProcess, static_cast<DWORD>(opt.wallMs));
  const bool wallTimeout = (waitResult == WAIT_TIMEOUT);
  const auto end = std::chrono::steady_clock::now();
  if (wallTimeout) {
    out->timedOut = true;
    const KillOutcome kill = terminateWholeJob(job, pi.hProcess);
    out->reapMs = kill.reapMs;
    debugTrace(
        "wall timeout: TerminateJobObject ok=%d jobErr=%lu reaped=%d fallback=%d "
        "fallbackErr=%lu reapMs=%lld active=%lld",
        kill.jobTerminated ? 1 : 0, kill.jobError, kill.reaped ? 1 : 0,
        kill.fallbackUsed ? 1 : 0, kill.fallbackError, kill.reapMs, queryActiveProcesses(job));
    if (!kill.jobTerminated) {
      out->killNote = "TerminateJobObject failed: " + describeWin32Error(kill.jobError);
    }
    if (!kill.reaped) {
      if (!out->killNote.empty()) out->killNote += "; ";
      out->killNote += "process did not signal termination within 10s";
      if (kill.fallbackUsed && kill.fallbackError != 0) {
        out->killNote += " (TerminateProcess fallback error: " +
                         describeWin32Error(kill.fallbackError) + ")";
      }
    }
  } else {
    debugTrace("child exited before wall timeout (wait=%lu)", waitResult);
  }
  out->wallMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();

  DWORD exitCode = 0;
  if (!GetExitCodeProcess(pi.hProcess, &exitCode)) {
    out->error = "GetExitCodeProcess failed: " + describeWin32Error(GetLastError());
    exitCode = 0;
  }
  out->exitCode = exitCode;
  out->signal = signalForExitCode(exitCode);

  FILETIME creation{}, exitTime{}, kernelTime{}, userTime{};
  if (GetProcessTimes(pi.hProcess, &creation, &exitTime, &kernelTime, &userTime)) {
    ULARGE_INTEGER k{}, u{};
    k.LowPart = kernelTime.dwLowDateTime;
    k.HighPart = kernelTime.dwHighDateTime;
    u.LowPart = userTime.dwLowDateTime;
    u.HighPart = userTime.dwHighDateTime;
    out->cpuMs = static_cast<long long>((k.QuadPart + u.QuadPart) / 10000ULL);
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION accounting{};
  if (QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &accounting,
                                sizeof(accounting), nullptr)) {
    out->peakMemKb =
        static_cast<long long>(accounting.PeakProcessMemoryUsed / 1024ULL);
  }

  // A user-mode time violation is reported by the job; surface it as timedOut.
  JOBOBJECT_LIMIT_VIOLATION_INFORMATION violation{};
  if (QueryInformationJobObject(job, JobObjectLimitViolationInformation, &violation,
                                sizeof(violation), nullptr)) {
    if ((violation.ViolationLimitFlags & JOB_OBJECT_LIMIT_PROCESS_TIME) != 0) {
      out->timedOut = true;
    }
  }

  const std::string badAllocMarkers[] = {
      "bad_alloc", "std::bad_alloc", "not enough memory",
      "std::length_error", "cannot allocate memory"};
  const long long limitBytes =
      static_cast<long long>(opt.memoryMb) * 1024LL * 1024LL;
  // The memory limit makes allocations fail instead of killing the process. A
  // program can therefore hang (or die slowly) inside its allocation-failure /
  // terminate path even though the limit clearly capped it; classify by peak.
  if (out->peakMemKb * 1024LL >= limitBytes * 9LL / 10LL) {
    out->oom = true;
  }
  if (!out->timedOut &&
      (exitCode == kStatusNoMemory || exitCode == kStatusCommitmentLimit)) {
    out->oom = true;
  }
  for (const std::string& marker : badAllocMarkers) {
    if (fileContainsMarker(hErr, marker.c_str(), marker.size())) {
      out->oom = true;
      break;
    }
  }

  out->stdoutBytes = fileSize(hOut);
  out->stderrBytes = fileSize(hErr);

  // Defensive: with ActiveProcessLimit=1 nothing should be left, but never leak
  // job members if the limit was configured more loosely by a future caller.
  const long long leftover = queryActiveProcesses(job);
  if (leftover > 0) {
    const KillOutcome kill = terminateWholeJob(job, pi.hProcess);
    out->reapMs = kill.reapMs;
    long long remaining = queryActiveProcesses(job);
    for (int i = 0; i < 20 && remaining > 0; ++i) {
      Sleep(50);
      remaining = queryActiveProcesses(job);
    }
    debugTrace("leftover processes after main exit: %lld -> %lld", leftover, remaining);
    if (remaining > 0) {
      if (!out->killNote.empty()) out->killNote += "; ";
      out->killNote +=
          "job still reports " + std::to_string(remaining) + " active process(es)";
    }
  }

  CloseHandle(pi.hThread);
  if (pi.hProcess != nullptr) CloseHandle(pi.hProcess);
  CloseHandle(hIn);
  CloseHandle(hOut);
  CloseHandle(hErr);
  CloseHandle(job);
  out->ok = true;
  return 0;
}

}  // namespace

int main() {
  Result result;
  Options opt;
  std::string parseError;

  const std::vector<std::wstring> args = splitArgs();
  if (!parseOptions(args, &opt, &parseError)) {
    result.error = parseError;
    emitJson(result);
    return 2;
  }

  const int rc = run(opt, &result);
  if (rc != 0) {
    emitJson(result);
    return rc;
  }
  emitJson(result);
  return 0;
}
