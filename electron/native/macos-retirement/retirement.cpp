// Standalone owned SDK/lifetime probe. No production factory uses this addon.
// All syscall work and descriptor closure run asynchronously; TS owns policy.
#include <node_api.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <sys/event.h>
#include <fcntl.h>
#include <unistd.h>
#include <pthread.h>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <stdexcept>

namespace {
constexpr napi_type_tag tag{0x1470b2f58ba847efULL, 0xa61e94598de70c35ULL};
std::atomic<unsigned> reserved{0};
std::atomic<unsigned> environmentCleanups{0}, suppressedCompletions{0}, totalDisposals{0};
enum class Kind { Record, Absent, Failure };
struct Snapshot {
  Kind kind = Kind::Failure;
  const char* category = "SYSCALL_FAILED";
  uint32_t pid = 0, parent = 0, uid = 0, real = 0, saved = 0;
  uint64_t seconds = 0, micros = 0;
  const char* state = "unknown";
};
struct Owner {
  napi_env env;
  const pid_t pid, parent;
  const uid_t uid;
  const bool synthetic;
  std::atomic<int> descriptor{-1};
  std::atomic<bool> busy{false}, closing{false}, closed{false}, envClosing{false};
  std::atomic<bool> watched{false}, exitSeen{false}, cloexec{false};
  std::atomic<bool> zombieSeen{false};
  std::atomic<bool> barrierArmed{false}, barrierEntered{false}, barrierReleased{false};
  std::atomic<unsigned> queries{0}, disposals{0};
  std::atomic<unsigned> kernelQueries{0}, watchAllocations{0};
  std::mutex barrierMutex;
  std::condition_variable barrierCondition;
  unsigned automaticReleaseMs = 0;
  napi_async_work closeWork = nullptr;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  std::shared_ptr<Owner>* cleanupOwner = nullptr;
  napi_deferred closeDeferred = nullptr;
  napi_ref closePromise = nullptr;
  bool closeQueued = false;
  bool closeFailed = false;
  Owner(napi_env environment, pid_t process, uid_t user, pid_t expectedParent, bool syntheticOnly)
      : env(environment), pid(process), parent(expectedParent), uid(user), synthetic(syntheticOnly) {}
};
enum class Operation { Bind, Observe };
struct Work {
  std::shared_ptr<Owner> owner;
  Operation operation;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  Snapshot first, second;
  const char* failure = nullptr;
};

void check(napi_status status) { if (status != napi_ok) throw std::runtime_error("NATIVE_FAILED"); }
napi_value text(napi_env env, const char* value) { napi_value out; check(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &out)); return out; }
napi_value number(napi_env env, uint32_t value) { napi_value out; check(napi_create_uint32(env, value, &out)); return out; }
napi_value boolean(napi_env env, bool value) { napi_value out; check(napi_get_boolean(env, value, &out)); return out; }
void put(napi_env env, napi_value target, const char* key, napi_value value) { check(napi_set_named_property(env, target, key, value)); }
napi_value error(napi_env env) {
  napi_value value; check(napi_create_error(env, text(env, "TEARDOWN_FAILED"), text(env, "Process retirement: TEARDOWN_FAILED."), &value)); return value;
}
void reject(napi_env env, napi_deferred deferred) noexcept {
  try { napi_reject_deferred(env, deferred, error(env)); }
  catch (...) { napi_throw_error(env, "TEARDOWN_FAILED", "Process retirement: TEARDOWN_FAILED."); }
}
napi_value fail(napi_env env) { napi_throw_error(env, "TEARDOWN_FAILED", "Process retirement: TEARDOWN_FAILED."); return nullptr; }
uint32_t integer(napi_env env, napi_value value) {
  double raw = 0; check(napi_get_value_double(env, value, &raw));
  if (!std::isfinite(raw) || raw < 0 || raw > 0x7fffffff || raw != static_cast<uint32_t>(raw)) throw std::runtime_error("NATIVE_FAILED");
  return static_cast<uint32_t>(raw);
}
std::shared_ptr<Owner> owner(napi_env env, napi_value object) {
  bool tagged = false; check(napi_check_object_type_tag(env, object, &tag, &tagged));
  if (!tagged) throw std::runtime_error("NATIVE_FAILED");
  void* value = nullptr; check(napi_unwrap(env, object, &value));
  if (!value) throw std::runtime_error("NATIVE_FAILED");
  auto result = *static_cast<std::shared_ptr<Owner>*>(value);
  if (result->env != env) throw std::runtime_error("NATIVE_FAILED");
  return result;
}
Snapshot snapshot(pid_t pid) {
  proc_bsdinfo info{};
  errno = 0;
  // Nonzero arg is essential: arg=0 excludes an unreaped zombie.
  const int count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &info, sizeof(info));
  const int savedErrno = errno;
  Snapshot out;
  if (count == 0) {
    if (savedErrno == ESRCH) out.kind = Kind::Absent;
    else out.category = (savedErrno == EACCES || savedErrno == EPERM) ? "ACCESS_REFUSED" : "SYSCALL_FAILED";
    return out;
  }
  if (count != static_cast<int>(sizeof(info))) { out.category = "SHORT_RECORD"; return out; }
  switch (info.pbi_status) {
    case SIDL: out.state = "idle"; break;
    case SRUN: out.state = "running"; break;
    case SSLEEP: out.state = "sleeping"; break;
    case SSTOP: out.state = "stopped"; break;
    case SZOMB: out.state = "zombie"; break;
    default: out.category = "INVALID_RECORD"; return out;
  }
  if (info.pbi_pid != static_cast<uint32_t>(pid) || !info.pbi_start_tvsec || info.pbi_start_tvusec >= 1000000) {
    out.category = "INVALID_RECORD"; return out;
  }
  out.kind = Kind::Record;
  out.pid = info.pbi_pid; out.parent = info.pbi_ppid;
  out.uid = info.pbi_uid; out.real = info.pbi_ruid; out.saved = info.pbi_svuid;
  out.seconds = info.pbi_start_tvsec; out.micros = info.pbi_start_tvusec;
  // comm/name, groups and all other native fields are discarded here.
  return out;
}
bool owns(const Owner& value, const Snapshot& info) {
  return info.kind == Kind::Record && info.pid == static_cast<uint32_t>(value.pid)
      && info.parent == static_cast<uint32_t>(value.parent) && info.uid == value.uid && info.real == value.uid && info.saved == value.uid;
}
void barrier(Owner& value) {
  if (!value.barrierArmed.exchange(false)) return;
  std::unique_lock<std::mutex> lock(value.barrierMutex);
  value.barrierEntered.store(true);
  if (value.automaticReleaseMs) {
    value.barrierCondition.wait_for(lock, std::chrono::milliseconds(value.automaticReleaseMs), [&] { return value.barrierReleased.load(); });
    value.barrierReleased.store(true);
  } else value.barrierCondition.wait(lock, [&] { return value.barrierReleased.load(); });
}
void bind(Work& job) {
  Owner& value = *job.owner;
  value.kernelQueries.fetch_add(1);
  job.first = snapshot(value.pid);
  if (job.first.kind != Kind::Record) { job.second = job.first; return; }
  if (!owns(value, job.first)) { job.failure = "IDENTITY_FAILED"; return; }
  const int descriptor = kqueue();
  if (descriptor < 0) { job.failure = "WATCH_FAILED"; return; }
  value.descriptor.store(descriptor);
  value.watchAllocations.fetch_add(1);
  const int flags = fcntl(descriptor, F_GETFD);
  if (flags < 0 || !(flags & FD_CLOEXEC)) { job.failure = "WATCH_FAILED"; return; }
  value.cloexec.store(true);
  struct kevent request{}, receipt{};
  EV_SET(&request, static_cast<uintptr_t>(value.pid), EVFILT_PROC, EV_ADD | EV_ENABLE | EV_RECEIPT, NOTE_EXIT, 0, &value);
  const timespec immediate{};
  errno = 0;
  const int count = kevent(descriptor, &request, 1, &receipt, 1, &immediate);
  const int savedErrno = errno;
  if (count != 1 || receipt.ident != static_cast<uintptr_t>(value.pid) || receipt.filter != EVFILT_PROC || !(receipt.flags & EV_ERROR)) {
    (void)savedErrno; job.failure = "WATCH_FAILED"; return;
  }
  if (receipt.data != 0) {
    // Registration ESRCH is not reaping evidence. Query arg=1 separately.
    if (receipt.data == ESRCH) { value.kernelQueries.fetch_add(1); job.second = snapshot(value.pid); return; }
    job.failure = "WATCH_FAILED"; return;
  }
  value.watched.store(true);
  value.kernelQueries.fetch_add(1);
  job.second = snapshot(value.pid);
}
void observe(Work& job) {
  Owner& value = *job.owner;
  if (value.watched.load()) {
    struct kevent event{}; const timespec immediate{};
    const int count = kevent(value.descriptor.load(), nullptr, 0, &event, 1, &immediate);
    if (count < 0 || count > 1) { job.failure = "WATCH_FAILED"; return; }
    if (count == 1) {
      if (event.ident != static_cast<uintptr_t>(value.pid) || event.filter != EVFILT_PROC || event.udata != &value
          || (event.flags & EV_ERROR) || !(event.fflags & NOTE_EXIT) || (event.fflags & ~NOTE_EXIT)) {
        job.failure = "WATCH_FAILED"; return;
      }
      value.exitSeen.store(true);
    }
  }
  value.kernelQueries.fetch_add(1);
  job.second = snapshot(value.pid);
}
napi_value encode(napi_env env, const Snapshot& value) {
  napi_value out; check(napi_create_object(env, &out));
  put(env, out, "kind", text(env, value.kind == Kind::Record ? "record" : value.kind == Kind::Absent ? "absent" : "failure"));
  if (value.kind == Kind::Failure) put(env, out, "category", text(env, value.category));
  if (value.kind == Kind::Record) {
    put(env, out, "pid", number(env, value.pid)); put(env, out, "parentPid", number(env, value.parent));
    put(env, out, "uid", number(env, value.uid)); put(env, out, "realUid", number(env, value.real)); put(env, out, "savedUid", number(env, value.saved));
    put(env, out, "state", text(env, value.state));
    napi_value seconds, micros; check(napi_create_bigint_uint64(env, value.seconds, &seconds)); check(napi_create_bigint_uint64(env, value.micros, &micros));
    put(env, out, "seconds", seconds); put(env, out, "micros", micros);
  }
  return out;
}
void startClose(Owner& value);
void execute(napi_env, void* data) {
  auto& job = *static_cast<Work*>(data);
  try {
    barrier(*job.owner); job.owner->queries.fetch_add(1);
    if (job.owner->synthetic) job.second.category = "SYNTHETIC_ONLY";
    else if (job.operation == Operation::Bind) bind(job); else observe(job);
    if ((job.first.kind == Kind::Record && !std::strcmp(job.first.state, "zombie")) ||
        (job.second.kind == Kind::Record && !std::strcmp(job.second.state, "zombie"))) job.owner->zombieSeen.store(true);
  } catch (...) { job.failure = "NATIVE_FAILED"; }
}
void complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Work> job(static_cast<Work*>(data));
  auto value = job->owner;
  if (!value->envClosing.load()) {
    try {
      if (status != napi_ok || job->failure) reject(env, job->deferred);
      else {
        napi_value reply; check(napi_create_object(env, &reply));
        if (job->operation == Operation::Bind) put(env, reply, "first", encode(env, job->first));
        put(env, reply, "second", encode(env, job->second));
        put(env, reply, "watched", boolean(env, value->watched.load()));
        put(env, reply, "exitSeen", boolean(env, value->exitSeen.load()));
        put(env, reply, "cloexec", boolean(env, value->cloexec.load()));
        check(napi_resolve_deferred(env, job->deferred, reply));
      }
    } catch (...) { reject(env, job->deferred); }
  } else suppressedCompletions.fetch_add(1);
  napi_delete_async_work(env, job->work);
  value->busy.store(false);
  if (value->closing.load()) startClose(*value);
}
void executeClose(napi_env, void* data) {
  auto& value = *static_cast<Owner*>(data);
  const int descriptor = value.descriptor.load();
  // No retry on an ambiguous close result: the descriptor might have been reused.
  if (descriptor >= 0 && ::close(descriptor) != 0) { value.closeFailed = true; return; }
  value.descriptor.store(-1); value.closed.store(true); value.disposals.fetch_add(1);
}
void completeClose(napi_env env, napi_status status, void* data) {
  auto& value = *static_cast<Owner*>(data);
  // The cleanup hook's shared owner stays alive until after this completion.
  auto retained = *value.cleanupOwner;
  (void)retained;
  if (status != napi_ok || value.closeFailed || !value.closed.load()) {
    if (!value.envClosing.load() && value.closeDeferred) reject(env, value.closeDeferred);
    // Keep the cleanup hook and allocation; an uncertain close cannot free it.
    return;
  }
  // A successful descriptor close alone is not the complete resource receipt.
  // Keep the hook owner/reservation if native work/reference retirement fails.
  if (napi_delete_async_work(env, value.closeWork) != napi_ok) {
    value.closeFailed = true;
    if (!value.envClosing.load() && value.closeDeferred) reject(env, value.closeDeferred);
    return;
  }
  value.closeWork = nullptr;
  if (value.closePromise) {
    if (napi_delete_reference(env, value.closePromise) != napi_ok) {
      value.closeFailed = true;
      if (!value.envClosing.load() && value.closeDeferred) reject(env, value.closeDeferred);
      return;
    }
    value.closePromise = nullptr;
  }
  const bool environmentClosing = value.envClosing.load();
  if (napi_remove_async_cleanup_hook(value.cleanup) != napi_ok) {
    value.closeFailed = true;
    if (!environmentClosing && value.closeDeferred) reject(env, value.closeDeferred);
    return;
  }
  value.cleanup = nullptr;
  delete value.cleanupOwner; value.cleanupOwner = nullptr;
  reserved.fetch_sub(1);
  totalDisposals.fetch_add(1);
  // During teardown hook removal may permit environment destruction. No more
  // env/JS calls follow it in that branch. Normal explicit close still has JS.
  if (!environmentClosing && value.closeDeferred) {
    napi_value output;
    if (napi_get_undefined(env, &output) == napi_ok) napi_resolve_deferred(env, value.closeDeferred, output);
  }
}
void startClose(Owner& value) {
  if (value.closeQueued || value.busy.load()) return;
  value.closeQueued = true;
  if (napi_queue_async_work(value.env, value.closeWork) != napi_ok) {
    value.closeFailed = true;
    if (!value.envClosing.load() && value.closeDeferred) reject(value.env, value.closeDeferred);
  }
}
void cleanup(napi_async_cleanup_hook_handle, void* data) {
  auto& value = **static_cast<std::shared_ptr<Owner>*>(data);
  value.envClosing.store(true); value.closing.store(true);
  environmentCleanups.fetch_add(1);
  startClose(value);
}
void finalize(napi_env, void* data, void*) { delete static_cast<std::shared_ptr<Owner>*>(data); }
napi_value createOwner(napi_env env, pid_t pid, uid_t uid, pid_t parent, bool synthetic) {
  std::shared_ptr<Owner> value;
  bool acquired = false;
  try {
    unsigned empty = 0;
    if (!reserved.compare_exchange_strong(empty, 1)) throw std::runtime_error("NATIVE_FAILED");
    acquired = true;
    value = std::make_shared<Owner>(env, pid, uid, parent, synthetic);
    check(napi_create_async_work(env, nullptr, text(env, "owned-retirement-close"), executeClose, completeClose, value.get(), &value->closeWork));
    value->cleanupOwner = new std::shared_ptr<Owner>(value);
    check(napi_add_async_cleanup_hook(env, cleanup, value->cleanupOwner, &value->cleanup));
    auto wrapped = std::make_unique<std::shared_ptr<Owner>>(value);
    napi_value object; check(napi_create_object(env, &object));
    check(napi_wrap(env, object, wrapped.get(), finalize, nullptr, nullptr)); wrapped.release();
    check(napi_type_tag_object(env, object, &tag));
    return object;
  } catch (...) {
    if (value && value->cleanup) { value->closing.store(true); startClose(*value); }
    else {
      if (value && value->closeWork) napi_delete_async_work(env, value->closeWork);
      if (value) delete value->cleanupOwner;
      if (acquired) reserved.fetch_sub(1);
    }
    return fail(env);
  }
}
napi_value create(napi_env env, napi_callback_info info) {
  try {
    size_t count = 3; napi_value args[3]; check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 3 || !pthread_main_np()) throw std::runtime_error("NATIVE_FAILED");
    napi_value global, process, type; check(napi_get_global(env, &global));
    check(napi_get_named_property(env, global, "process", &process)); check(napi_get_named_property(env, process, "type", &type));
    char name[16]{}; size_t size = 0; check(napi_get_value_string_utf8(env, type, name, sizeof(name), &size));
    if (size != 7 || std::strcmp(name, "browser")) throw std::runtime_error("NATIVE_FAILED");
    const auto pid = integer(env, args[0]), uid = integer(env, args[1]), parent = integer(env, args[2]);
    if (!pid || pid == static_cast<uint32_t>(getpid()) || parent != static_cast<uint32_t>(getpid()) || uid != getuid() || uid != geteuid()) {
      throw std::runtime_error("NATIVE_FAILED");
    }
    return createOwner(env, static_cast<pid_t>(pid), uid, static_cast<pid_t>(parent), false);
  } catch (...) { return fail(env); }
}
napi_value createSynthetic(napi_env env, napi_callback_info info) {
  try {
    size_t count = 0; check(napi_get_cb_info(env, info, &count, nullptr, nullptr, nullptr));
    if (count != 0 || pthread_main_np()) throw std::runtime_error("NATIVE_FAILED");
    // This test-only Worker owner takes no kernel target and cannot run libproc.
    return createOwner(env, 0, getuid(), 0, true);
  } catch (...) { return fail(env); }
}
napi_value query(napi_env env, napi_callback_info info, Operation operation) {
  std::shared_ptr<Owner> value; bool acquired = false;
  std::unique_ptr<Work> job;
  try {
    size_t count = 1; napi_value arg; check(napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr)); if (count != 1) throw std::runtime_error("NATIVE_FAILED");
    value = owner(env, arg);
    if (value->closing.load() || value->closed.load() || (operation == Operation::Bind && value->queries.load() != 0)) throw std::runtime_error("NATIVE_FAILED");
    if (value->busy.exchange(true)) throw std::runtime_error("NATIVE_FAILED");
    acquired = true;
    job = std::make_unique<Work>(); job->owner = value; job->operation = operation;
    napi_value promise; check(napi_create_promise(env, &job->deferred, &promise));
    check(napi_create_async_work(env, nullptr, text(env, "owned-retirement-query"), execute, complete, job.get(), &job->work));
    check(napi_queue_async_work(env, job->work)); job.release(); return promise;
  } catch (...) {
    if (job && job->work) napi_delete_async_work(env, job->work);
    if (acquired) value->busy.store(false);
    return fail(env);
  }
}
napi_value bindCandidate(napi_env env, napi_callback_info info) { return query(env, info, Operation::Bind); }
napi_value observeCall(napi_env env, napi_callback_info info) { return query(env, info, Operation::Observe); }
napi_value closeCall(napi_env env, napi_callback_info info) {
  try {
    size_t count = 1; napi_value arg; check(napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr)); if (count != 1) throw std::runtime_error("NATIVE_FAILED");
    auto value = owner(env, arg);
    if (value->closeFailed) throw std::runtime_error("NATIVE_FAILED");
    if (value->closePromise) { napi_value promise; check(napi_get_reference_value(env, value->closePromise, &promise)); return promise; }
    napi_value promise; check(napi_create_promise(env, &value->closeDeferred, &promise));
    if (value->closed.load()) { napi_value out; check(napi_get_undefined(env, &out)); check(napi_resolve_deferred(env, value->closeDeferred, out)); return promise; }
    check(napi_create_reference(env, promise, 1, &value->closePromise));
    value->closing.store(true); startClose(*value); return promise;
  } catch (...) { return fail(env); }
}
napi_value probeState(napi_env env, napi_callback_info info) {
  try {
    size_t count = 1; napi_value arg; check(napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr)); if (count != 1) throw std::runtime_error("NATIVE_FAILED");
    const auto value = owner(env, arg); napi_value out; check(napi_create_object(env, &out));
    put(env, out, "busy", boolean(env, value->busy.load())); put(env, out, "closing", boolean(env, value->closing.load()));
    put(env, out, "closed", boolean(env, value->closed.load())); put(env, out, "descriptorOpen", boolean(env, value->descriptor.load() >= 0));
    put(env, out, "barrierEntered", boolean(env, value->barrierEntered.load()));
    put(env, out, "exitSeen", boolean(env, value->exitSeen.load())); put(env, out, "zombieSeen", boolean(env, value->zombieSeen.load()));
    put(env, out, "queries", number(env, value->queries.load())); put(env, out, "disposals", number(env, value->disposals.load()));
    put(env, out, "kernelQueries", number(env, value->kernelQueries.load())); put(env, out, "watchAllocations", number(env, value->watchAllocations.load()));
    put(env, out, "synthetic", boolean(env, value->synthetic));
    put(env, out, "reserved", number(env, reserved.load())); return out;
  } catch (...) { return fail(env); }
}
napi_value holdNext(napi_env env, napi_callback_info info) {
  try {
    size_t count = 2; napi_value args[2]; check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr)); if (count != 2) throw std::runtime_error("NATIVE_FAILED");
    auto value = owner(env, args[0]); const unsigned automatic = integer(env, args[1]);
    if (automatic > 2000 || value->busy.load() || value->closing.load() || value->barrierArmed.load()) throw std::runtime_error("NATIVE_FAILED");
    value->automaticReleaseMs = automatic; value->barrierReleased.store(false); value->barrierEntered.store(false); value->barrierArmed.store(true);
    napi_value out; check(napi_get_undefined(env, &out)); return out;
  } catch (...) { return fail(env); }
}
napi_value releaseBarrier(napi_env env, napi_callback_info info) {
  try {
    size_t count = 1; napi_value arg; check(napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr)); if (count != 1) throw std::runtime_error("NATIVE_FAILED");
    auto value = owner(env, arg); value->barrierReleased.store(true); value->barrierCondition.notify_all();
    napi_value out; check(napi_get_undefined(env, &out)); return out;
  } catch (...) { return fail(env); }
}
napi_value sdk(napi_env env, napi_callback_info) {
  try {
    napi_value out; check(napi_create_object(env, &out));
    put(env, out, "bsdInfoBytes", number(env, sizeof(proc_bsdinfo))); put(env, out, "keventBytes", number(env, sizeof(struct kevent)));
    put(env, out, "zombieLookupArgument", number(env, 1)); put(env, out, "napiVersion", number(env, 8));
    put(env, out, "probeOnly", boolean(env, true)); put(env, out, "reserved", number(env, reserved.load()));
    put(env, out, "environmentCleanups", number(env, environmentCleanups.load()));
    put(env, out, "suppressedCompletions", number(env, suppressedCompletions.load()));
    put(env, out, "totalDisposals", number(env, totalDisposals.load())); return out;
  } catch (...) { return fail(env); }
}
}  // namespace

NAPI_MODULE_INIT() {
  const char* github = std::getenv("GITHUB_ACTIONS"), *optIn = std::getenv("OPENWHISPER_OWNED_MAC_RETIREMENT_TEST");
  if (getuid() == 0 || !github || std::strcmp(github, "true") || !optIn || std::strcmp(optIn, "1")) return fail(env);
  const napi_property_descriptor methods[] = {
    {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createSynthetic", nullptr, createSynthetic, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"bindCandidate", nullptr, bindCandidate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"observe", nullptr, observeCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, closeCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"probeState", nullptr, probeState, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"holdNext", nullptr, holdNext, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseBarrier", nullptr, releaseBarrier, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sdk", nullptr, sdk, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok) return fail(env);
  return exports;
}
