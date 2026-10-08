#include "codec.hpp"
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <fcntl.h>
#include <future>
#include <limits>
#include <map>
#include <mutex>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

namespace owbus {
struct Failure : std::runtime_error {
  explicit Failure(const char *code) : std::runtime_error(code) {}
};
struct State;
struct Callback;
struct Event;
struct Module;
// JS-thread-only lifetime/certificate fields. TSFN holders retain this record
// through their finalizers, independently of the module's environment lifetime.
struct Environment {
  napi_env env = nullptr;
  Module *module = nullptr;
  bool cleaning = false;
};
struct Retirement {
  std::shared_ptr<Environment> environment;
  std::string id;
  size_t callbacks = 0;
  bool opening_complete = false;
  bool close_started = false;
  bool early_identity = false;
  bool close_claimed = false;
  bool stopped = false;
  bool failed = false;
  napi_deferred deferred = nullptr;
  napi_ref promise = nullptr;
};
static void finish_retirement(const std::shared_ptr<Retirement> &record);
static void deliver(Callback *handler, Event *event);
struct Deadline {
  std::mutex mutex;
  std::condition_variable clock;
  bool done = false;
  std::thread thread;
  Deadline(GCancellable *cancellation, int milliseconds)
      : Deadline(cancellation, std::chrono::microseconds(milliseconds * 1000)) {}
  Deadline(GCancellable *cancellation, std::chrono::microseconds remaining)
      : thread([this, cancellation, remaining] {
          std::unique_lock<std::mutex> lock(mutex);
          if (!clock.wait_for(lock, remaining,
                              [this] { return done; }))
            g_cancellable_cancel(cancellation);
        }) {}
  ~Deadline() {
    {
      std::lock_guard<std::mutex> lock(mutex);
      done = true;
    }
    clock.notify_one();
    thread.join();
  }
};
struct Callback {
  napi_threadsafe_function function = nullptr;
  std::weak_ptr<State> state;
  std::shared_ptr<Retirement> retirement;
};
struct Event {
  std::string kind, id, sender, path, interface, member;
  gint64 expires_at = 0;
  Variant body;
  explicit Event(GVariant *value)
      : body(value ? g_variant_ref(value) : nullptr) {}
};
struct Invocation {
  GDBusMethodInvocation *method = nullptr;
  std::string sender;
  gint64 expires_at = 0;
};
static Callback *callback(napi_env env, napi_value function,
                          const std::shared_ptr<State> &owner);
struct State : std::enable_shared_from_this<State> {
  std::string id = uuid();
  std::string unique;
  std::shared_ptr<Retirement> retirement;
  std::atomic<bool> closing{false};
  GDBusConnection *connection = nullptr;
  GMainContext *context = nullptr;
  GMainLoop *loop = nullptr;
  std::thread thread;
  GCancellable *opening = g_cancellable_new();
  std::mutex mutex;
  std::recursive_mutex lifecycle;
  std::map<std::string, GCancellable *> calls;
  // Native start/completion holders drain without waiting for JS finalizers.
  // Admission increments before scheduling; the final native holder decrements.
  std::atomic<size_t> context_calls{0};
  std::atomic<bool> drain_requested{false};
  std::atomic<bool> call_disposal_failed{false};
  std::map<std::string, int> fds;
  // Subscriptions/exports/invocations belong exclusively to the GLib context.
  std::map<std::string, std::pair<guint, Callback *>> subscriptions;
  guint export_id = 0;
  guint control_owner_subscription = 0;
  Callback *export_callback = nullptr;
  Callback *lifecycle_callback = nullptr;
  std::map<std::string, Invocation> invocations;
  std::map<std::string, GSource *> expiries;
  ~State();
  void stop();
  void context_call_finished() {
    if (context_calls.fetch_sub(1) == 1 && drain_requested)
      g_main_loop_quit(loop); // Thread-safe; no JS callback is awaited.
  }
  void fail() {
    closing = true;
    g_cancellable_cancel(opening);
    std::lock_guard<std::mutex> guard(mutex);
    for (auto &item : calls)
      g_cancellable_cancel(item.second);
    for (auto &item : fds)
      ::close(item.second);
    fds.clear();
    if (connection)
      g_dbus_connection_close(connection, nullptr, nullptr, nullptr);
  }
  int duplicate(const std::string &token) {
    std::lock_guard<std::mutex> guard(mutex);
    auto found = fds.find(token);
    if (closing || found == fds.end())
      throw Failure("INVALID_FD");
    int result = fcntl(found->second, F_DUPFD_CLOEXEC, 3);
    if (result < 0)
      throw Failure("INVALID_FD");
    return result;
  }
  std::string retain(int fd) {
    bool transferred = false;
    try {
      std::lock_guard<std::mutex> guard(mutex);
      if (closing || fds.size() >= max_fds ||
          fcntl(fd, F_SETFD, FD_CLOEXEC) < 0)
        throw Failure("INVALID_FD");
      auto token = uuid();
      if (!fds.emplace(token, fd).second)
        throw Failure("INVALID_FD");
      transferred = true;
      return token;
    } catch (...) {
      if (!transferred)
        ::close(fd); // UUID/map allocation refusal still owns the incoming FD.
      throw;
    }
  }
  void drop(const std::string &token) {
    std::lock_guard<std::mutex> guard(mutex);
    auto found = fds.find(token);
    if (found == fds.end())
      throw Failure("INVALID_FD");
    ::close(found->second);
    fds.erase(found);
  }
  template <class F> void in_context(F operation) {
    std::lock_guard<std::recursive_mutex> lifetime(lifecycle);
    if (!context || !thread.joinable())
      throw Failure("CLOSED");
    auto task =
        std::make_shared<std::packaged_task<void()>>(std::move(operation));
    auto result = task->get_future();
    auto *holder = new std::shared_ptr<std::packaged_task<void()>>(task);
    g_main_context_invoke_full(
        context, G_PRIORITY_DEFAULT,
        [](gpointer pointer) -> gboolean {
          auto *value =
              static_cast<std::shared_ptr<std::packaged_task<void()>> *>(
                  pointer);
          (**value)();
          return G_SOURCE_REMOVE;
        },
        holder,
        [](gpointer pointer) {
          delete static_cast<std::shared_ptr<std::packaged_task<void()>> *>(
              pointer);
        });
    result.get();
  }
};
struct Module {
  std::map<std::string, std::shared_ptr<State>> states;
  std::shared_ptr<Environment> environment;
  explicit Module(napi_env env) : environment(std::make_shared<Environment>()) {
    environment->env = env;
    environment->module = this;
  }
  void cleanup() {
    environment->cleaning = true;
    // Cancel queued/opening work before any serialized stop. No JS finalizer
    // is awaited here: abort only schedules finalization on the environment loop.
    for (auto &item : states) {
      item.second->closing = true;
      g_cancellable_cancel(item.second->opening);
      std::lock_guard<std::mutex> guard(item.second->mutex);
      for (auto &call : item.second->calls)
        g_cancellable_cancel(call.second);
    }
    for (auto &item : states) {
      try {
        item.second->stop();
      } catch (...) { /* Process disposal is the final fence. */
      }
    }
  }
  ~Module() {
    cleanup();
    environment->module = nullptr;
  }
};
static void abort_callback(Callback *callback) {
  if (callback)
    napi_release_threadsafe_function(callback->function, napi_tsfn_abort);
}
void State::stop() {
  std::lock_guard<std::recursive_mutex> lifetime(lifecycle);
  closing = true;
  g_cancellable_cancel(opening);
  {
    std::lock_guard<std::mutex> guard(mutex);
    for (auto &item : calls)
      g_cancellable_cancel(item.second);
  }
  if (context && thread.joinable()) {
    in_context([this] {
      for (auto &item : subscriptions) {
        g_dbus_connection_signal_unsubscribe(connection, item.second.first);
        abort_callback(item.second.second);
      }
      subscriptions.clear();
      if (export_id) {
        g_dbus_connection_unregister_object(connection, export_id);
        export_id = 0;
      }
      if (control_owner_subscription) {
        g_dbus_connection_signal_unsubscribe(connection,
                                             control_owner_subscription);
        control_owner_subscription = 0;
      }
      abort_callback(export_callback);
      export_callback = nullptr;
      for (auto &item : invocations) {
        g_dbus_method_invocation_return_dbus_error(
            item.second.method, "io.github.whisperfree.Error.Unavailable",
            "Unavailable");
        g_object_unref(item.second.method);
      }
      invocations.clear();
      for (auto &item : expiries) {
        g_source_destroy(item.second);
        g_source_unref(item.second);
      }
      expiries.clear();
      drain_requested = true;
      if (context_calls == 0)
        g_main_loop_quit(loop);
    });
    thread.join();
  }
  abort_callback(lifecycle_callback);
  lifecycle_callback = nullptr;
  bool disposed = true;
  if (connection && !g_dbus_connection_is_closed(connection)) {
    GError *error = nullptr;
    GCancellable *cancellation = g_cancellable_new();
    {
      Deadline deadline(cancellation, 2000);
      g_dbus_connection_close_sync(connection, cancellation, &error);
    }
    g_object_unref(cancellation);
    disposed = g_dbus_connection_is_closed(connection);
    if (error)
      g_error_free(error);
  }
  std::lock_guard<std::mutex> guard(mutex);
  for (auto &item : fds)
    ::close(item.second);
  fds.clear();
  if (!disposed || call_disposal_failed)
    throw Failure("TEARDOWN_FAILED");
}
State::~State() {
  try {
    stop();
  } catch (...) { /* No successful disposal acknowledgment is issued. */
  }
  if (connection)
    g_signal_handlers_disconnect_by_data(connection, this);
  if (connection)
    g_object_unref(connection);
  if (loop)
    g_main_loop_unref(loop);
  if (context)
    g_main_context_unref(context);
  g_object_unref(opening);
}
static Module *module(napi_env env) {
  void *value = nullptr;
  ok(napi_get_instance_data(env, &value));
  return static_cast<Module *>(value);
}
static std::shared_ptr<State> state(napi_env env, napi_value id,
                                    bool allow_closing = false) {
  auto name = string(env, id, 36);
  auto found = module(env)->states.find(name);
  if (found == module(env)->states.end() ||
      (!allow_closing && found->second->closing))
    throw Failure("CLOSED");
  return found->second;
}
static std::vector<napi_value> arguments(napi_env env, napi_callback_info info,
                                         size_t expected) {
  size_t count = expected + 1;
  std::vector<napi_value> values(count);
  ok(napi_get_cb_info(env, info, &count, values.data(), nullptr, nullptr));
  check(count == expected);
  values.resize(count);
  return values;
}
static napi_value undefined(napi_env env) {
  napi_value result;
  ok(napi_get_undefined(env, &result));
  return result;
}
static napi_value error(napi_env env, const char *code) {
  napi_value result;
  ok(napi_create_error(env, nullptr, string(env, "Linux transport failed."),
                       &result));
  put(env, result, "code", string(env, code));
  return result;
}
static void finish_retirement(const std::shared_ptr<Retirement> &record) {
  auto environment = record->environment;
  if (environment->cleaning || !environment->module)
    return;
  auto env = environment->env;
  try {
    if (record->failed) {
      if (record->deferred) {
        ok(napi_reject_deferred(env, record->deferred,
                                error(env, "TEARDOWN_FAILED")));
        record->deferred = nullptr;
      }
      // Keep the state and shared rejected close result: failed disposal does
      // not permit a replacement connection or a second cleanup transaction.
      return;
    }
    if (!record->stopped || !record->opening_complete || record->callbacks != 0)
      return;
    // beginOpen already handed out this owner. Even an automatically stopped
    // failed opening stays addressable until that caller claims its certificate.
    if (record->early_identity && !record->close_claimed)
      return;
    if (record->promise) {
      ok(napi_delete_reference(env, record->promise));
      record->promise = nullptr;
    }
    if (record->deferred) {
      ok(napi_resolve_deferred(env, record->deferred, undefined(env)));
      record->deferred = nullptr;
    }
    environment->module->states.erase(record->id);
  } catch (...) {
    // An allocation/NAPI failure cannot supply a certificate. Environment
    // teardown still owns the retained state; never throw through a finalizer.
    record->failed = true;
  }
}
struct CloseJob {
  std::shared_ptr<State> owner;
  napi_async_work work = nullptr;
  bool failed = false;
};
static napi_value begin_close(napi_env env, const std::shared_ptr<State> &owner,
                              bool expose) {
  auto record = owner->retirement;
  napi_value promise = undefined(env);
  owner->closing = true;
  g_cancellable_cancel(owner->opening);
  {
    std::lock_guard<std::mutex> guard(owner->mutex);
    for (auto &item : owner->calls)
      g_cancellable_cancel(item.second);
  }
  if (expose) {
    record->close_claimed = true;
    if (record->promise) {
      ok(napi_get_reference_value(env, record->promise, &promise));
      return promise;
    }
    ok(napi_create_promise(env, &record->deferred, &promise));
    ok(napi_create_reference(env, promise, 1, &record->promise));
  }
  if (!record->close_started) {
    auto task = std::make_unique<CloseJob>(CloseJob{owner, nullptr, false});
    auto *job = task.get();
    record->close_started = true;
    try {
      ok(napi_create_async_work(
          env, nullptr, string(env, "OpenWhisperLinuxBusClose"),
          [](napi_env, void *pointer) {
            auto *task = static_cast<CloseJob *>(pointer);
            try { task->owner->stop(); }
            catch (...) { task->failed = true; }
          },
          [](napi_env current, napi_status status, void *pointer) {
            std::unique_ptr<CloseJob> task(static_cast<CloseJob *>(pointer));
            auto retirement = task->owner->retirement;
            const bool disposed =
                napi_delete_async_work(current, task->work) == napi_ok;
            retirement->failed = retirement->failed || task->failed ||
                                 status != napi_ok || !disposed;
            retirement->stopped = !retirement->failed;
            task.reset();
            // Finalizers and opening completion run on this same JS loop. A
            // pending callback never makes this callback block that loop. The
            // close work and its owner captures are gone before certification.
            finish_retirement(retirement);
          },
          job, &job->work));
      ok(napi_queue_async_work(env, job->work));
      task.release(); // The completion callback now owns the queued job.
    } catch (...) {
      record->failed = true;
      if (job->work)
        napi_delete_async_work(env, job->work);
    }
  }
  finish_retirement(record);
  return promise;
}
struct Job {
  napi_env env;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::function<void()> execute;
  std::function<napi_value()> complete;
  std::function<void()> failed;
  std::function<void(bool)> retired;
  std::string failure;
};
static napi_value async(napi_env env, std::function<void()> execute,
                        std::function<napi_value()> complete,
                        std::function<void()> failed = {},
                        std::function<void(bool)> retired = {}) {
  auto *job = new Job{env,
                      nullptr,
                      nullptr,
                      std::move(execute),
                      std::move(complete),
                      std::move(failed),
                      std::move(retired),
                      ""};
  napi_value promise;
  try {
    ok(napi_create_promise(env, &job->deferred, &promise));
    ok(napi_create_async_work(
        env, nullptr, string(env, "OpenWhisperLinuxBus"),
        [](napi_env, void *pointer) {
          auto *task = static_cast<Job *>(pointer);
          try {
            task->execute();
          } catch (const Failure &value) {
            task->failure = value.what();
          } catch (const Invalid &) {
            task->failure = "INVALID_FRAME";
          } catch (...) {
            task->failure = "TRANSPORT_FAILED";
          }
        },
        [](napi_env current, napi_status status, void *pointer) {
          std::unique_ptr<Job> task(static_cast<Job *>(pointer));
          bool settled = false;
          try {
            if (status != napi_ok && task->failure.empty())
              task->failure = "CANCELLED";
            if (task->failure.empty()) {
              ok(napi_resolve_deferred(current, task->deferred,
                                       task->complete()));
              settled = true;
            } else {
              if (task->failed)
                task->failed();
              ok(napi_reject_deferred(current, task->deferred,
                                      error(current, task->failure.c_str())));
              settled = true;
            }
          } catch (const Failure &value) {
            if (task->failed)
              task->failed();
            try {
              auto failure = error(current, value.what());
              settled = napi_reject_deferred(current, task->deferred,
                                              failure) == napi_ok;
            } catch (...) { /* No opening retirement certificate is issued. */ }
          } catch (...) {
            if (task->failed)
              task->failed();
            try {
              auto failure = error(current, "INVALID_FRAME");
              settled = napi_reject_deferred(current, task->deferred,
                                              failure) == napi_ok;
            } catch (...) { /* No opening retirement certificate is issued. */ }
          }
          const bool disposed =
              napi_delete_async_work(current, task->work) == napi_ok;
          auto retired = std::move(task->retired);
          task.reset();
          // Only opening uses this hook. Its ready outcome, async work and Job
          // captures must retire before close can publish an acknowledgment.
          if (retired)
            retired(settled && disposed);
        },
        job, &job->work));
    ok(napi_queue_async_work(env, job->work));
  } catch (...) {
    if (job->failed)
      job->failed();
    if (job->work)
      napi_delete_async_work(env, job->work);
    auto retired = std::move(job->retired);
    delete job;
    if (retired)
      retired(false); // No ready outcome was returned to the caller.
    throw;
  }
  return promise;
}
template <class F> static napi_value guarded(napi_env env, F function) {
  try {
    return function();
  } catch (const Failure &value) {
    napi_throw(env, error(env, value.what()));
  } catch (...) {
    napi_throw(env, error(env, "INVALID_FRAME"));
  }
  return nullptr;
}
static bool address_valid(const std::string &value) {
  const bool path = value.rfind("unix:path=", 0) == 0,
             abstract = value.rfind("unix:abstract=", 0) == 0;
  if ((!path && !abstract) || value.size() > 1024 ||
      value.find(';') != std::string::npos)
    return false;
  size_t start = path ? 10 : 14;
  if (start >= value.size() || (path && value[start] != '/'))
    return false;
  auto comma = value.find(',', start);
  std::string endpoint = value.substr(start, comma - start);
  if (endpoint.empty() ||
      !std::all_of(endpoint.begin(), endpoint.end(), [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
               (c >= '0' && c <= '9') || std::strchr("/_-.%", c);
      }))
    return false;
  if (comma != std::string::npos) {
    auto guid = value.substr(comma);
    if (guid.size() != 38 || guid.rfind(",guid=", 0) != 0 ||
        !std::all_of(guid.begin() + 6, guid.end(),
                     [](char c) { return g_ascii_isxdigit(c); }))
      return false;
  }
  return g_dbus_is_supported_address(value.c_str(), nullptr);
}
static uint64_t expiry(napi_env env, napi_value input) {
  auto value = string(env, input, 20);
  check(!value.empty() && value[0] >= '1' && value[0] <= '9' &&
        std::all_of(value.begin(), value.end(),
                    [](char c) { return c >= '0' && c <= '9'; }));
  uint64_t result = 0;
  for (char digit : value) {
    auto next = static_cast<uint64_t>(digit - '0');
    check(result <= (std::numeric_limits<uint64_t>::max() - next) / 10);
    result = result * 10 + next;
  }
  return result;
}
static std::chrono::microseconds remaining_open(uint64_t expires) {
  auto now = static_cast<uint64_t>(g_get_monotonic_time());
  if (expires <= now)
    throw Failure("TIMEOUT");
  return std::chrono::microseconds(std::min<uint64_t>(expires - now, 5000000));
}
struct OpenResult {
  std::shared_ptr<State> owner;
  napi_value ready;
};
static OpenResult start_open(napi_env env, const std::string &address,
                             napi_value lifecycle, uint64_t expires) {
  check(address_valid(address));
  if (expires)
    remaining_open(expires); // Refuse expiry before allocating an owner.
  check(module(env)->states.empty());
  auto owner = std::make_shared<State>();
  owner->retirement = std::make_shared<Retirement>();
  owner->retirement->environment = module(env)->environment;
  owner->retirement->id = owner->id;
  owner->retirement->early_identity = expires != 0;
  module(env)->states.emplace(owner->id, owner);
  try {
    if (lifecycle)
      owner->lifecycle_callback = callback(env, lifecycle, owner);
    auto ready = async(
        env,
        [owner, address, expires] {
          std::lock_guard<std::recursive_mutex> lifetime(owner->lifecycle);
          if (owner->closing)
            throw Failure("CLOSED");
          // The default worker keeps its existing five-second opening budget.
          // Explicit callers retain the original monotonic budget after dequeue.
          auto remaining = expires ? remaining_open(expires)
                                   : std::chrono::microseconds(5000000);
          Deadline deadline(owner->opening, remaining);
          GDBusAuthObserver *observer = g_dbus_auth_observer_new();
          g_signal_connect(
              observer, "allow-mechanism",
              G_CALLBACK(+[](GDBusAuthObserver *, const gchar *mechanism,
                             gpointer) -> gboolean {
                return g_str_equal(mechanism, "EXTERNAL");
              }),
              nullptr);
          g_signal_connect(
              observer, "authorize-authenticated-peer",
              G_CALLBACK(+[](GDBusAuthObserver *, GIOStream *,
                             GCredentials *credentials, gpointer) -> gboolean {
                GError *failure = nullptr;
                auto uid =
                    credentials
                        ? g_credentials_get_unix_user(credentials, &failure)
                        : static_cast<uid_t>(-1);
                if (failure)
                  g_error_free(failure);
                return uid == getuid();
              }),
              nullptr);
          GError *failure = nullptr;
          owner->context = g_main_context_new();
          g_main_context_push_thread_default(owner->context);
          owner->connection = g_dbus_connection_new_for_address_sync(
              address.c_str(),
              static_cast<GDBusConnectionFlags>(
                  G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
                  G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION),
              observer, owner->opening, &failure);
          g_main_context_pop_thread_default(owner->context);
          g_object_unref(observer);
          if (failure) {
            const bool cancelled =
                g_error_matches(failure, G_IO_ERROR, G_IO_ERROR_CANCELLED);
            g_error_free(failure);
            if (expires)
              remaining_open(expires);
            throw Failure(cancelled ? "CANCELLED" : "CONNECT_FAILED");
          }
          if (expires)
            remaining_open(expires);
          if (!owner->connection || owner->closing)
            throw Failure("CLOSED");
          g_dbus_connection_set_exit_on_close(owner->connection, FALSE);
          const char *unique =
              g_dbus_connection_get_unique_name(owner->connection);
          if (!unique || !g_dbus_is_unique_name(unique))
            throw Failure("CONNECT_FAILED");
          owner->unique = unique;
          g_signal_connect(owner->connection, "closed",
                           G_CALLBACK(+[](GDBusConnection *, gboolean, GError *,
                                          gpointer pointer) {
                             auto *target = static_cast<State *>(pointer);
                             if (target->closing)
                               return;
                             target->fail();
                             if (target->lifecycle_callback)
                               deliver(target->lifecycle_callback,
                                       new Event(nullptr));
                           }),
                           owner.get());
          owner->loop = g_main_loop_new(owner->context, FALSE);
          owner->thread = std::thread([raw = owner.get()] {
            g_main_context_push_thread_default(raw->context);
            g_main_loop_run(raw->loop);
            g_main_context_pop_thread_default(raw->context);
          });
          owner->in_context([] {});
        },
        [env, owner] {
          if (owner->closing)
            throw Failure("CLOSED");
          auto result = object(env);
          put(env, result, "connection", string(env, owner->id));
          put(env, result, "uniqueName", string(env, owner->unique));
          return result;
        },
        [env, owner] {
          if (!owner->retirement->environment->cleaning) {
            try { begin_close(env, owner, false); }
            catch (...) { owner->retirement->failed = true; }
          }
        },
        [record = owner->retirement](bool retired) {
          if (retired)
            record->opening_complete = true;
          else
            record->failed = true;
          finish_retirement(record);
        });
    return {owner, ready};
  } catch (...) {
    owner->retirement->early_identity = false; // No handle was returned.
    owner->retirement->failed = true;
    try { begin_close(env, owner, false); }
    catch (...) { /* Environment cleanup retains this failed owner. */ }
    throw;
  }
}
static napi_value open(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    size_t count = 3;
    std::vector<napi_value> args(count);
    ok(napi_get_cb_info(env, info, &count, args.data(), nullptr, nullptr));
    check(count == 1 || count == 2);
    return start_open(env, string(env, args[0], 1024),
                       count == 2 ? args[1] : nullptr, 0).ready;
  });
}
static napi_value begin_open(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 3);
    auto address = string(env, args[0], 1024);
    auto expires = expiry(env, args[1]);
    auto opening = start_open(env, address, args[2], expires);
    try {
      auto result = object(env);
      put(env, result, "connection", string(env, opening.owner->id));
      put(env, result, "ready", opening.ready);
      return result;
    } catch (...) {
      opening.owner->retirement->early_identity = false;
      begin_close(env, opening.owner, false);
      throw;
    }
  });
}
struct CallData {
  std::shared_ptr<State> owner;
  std::string id, destination, path, interface, member, expected;
  int timeout = 0;
  gint64 expires_at = 0;
  const char *failure = nullptr; // Closed native categories only.
  Variant body;
  GUnixFDList *input = g_unix_fd_list_new();
  GCancellable *cancel = g_cancellable_new();
  GDBusMessage *response = nullptr;
  ~CallData() {
    if (owner) {
      std::lock_guard<std::mutex> guard(owner->mutex);
      auto found = owner->calls.find(id);
      if (found != owner->calls.end() && found->second == cancel)
        owner->calls.erase(found);
    }
    if (response)
      g_object_unref(response);
    g_object_unref(input);
    g_object_unref(cancel);
  }
};
struct CallCompletion {
  std::shared_ptr<CallData> task;
  std::shared_ptr<Retirement> retirement;
  napi_deferred deferred = nullptr;
  napi_threadsafe_function function = nullptr;
  std::atomic<bool> finished{false};
  std::atomic<bool> disposal_failed{false};
  bool settled = false; // JS thread only.
};
// This lease belongs only to queued GLib starts and GIO callback holders, never
// the JS completion holder. Its destruction permits context shutdown even when
// the JS thread is busy or the environment is cleaning up.
struct ContextCall {
  std::shared_ptr<State> owner;
  bool admitted = false;
  explicit ContextCall(std::shared_ptr<State> value)
      : owner(std::move(value)) {}
  ~ContextCall() {
    if (admitted)
      owner->context_call_finished();
  }
};
struct ContextCallJob {
  // Reverse member destruction releases completion/resources before the lease.
  std::shared_ptr<ContextCall> lifetime;
  std::shared_ptr<CallCompletion> completion;
};
static void finish_call(const std::shared_ptr<CallCompletion> &completion,
                        const char *failure = nullptr) noexcept {
  if (completion->finished.exchange(true)) {
    completion->disposal_failed = true;
    completion->task->owner->call_disposal_failed = true;
    try {
      completion->task->owner->fail();
    } catch (...) { /* No certificate. */
    }
    return;
  }
  completion->task->failure = failure;
  const auto queued = napi_call_threadsafe_function(
      completion->function, nullptr, napi_tsfn_nonblocking);
  if (queued == napi_ok) {
    if (napi_release_threadsafe_function(completion->function,
                                         napi_tsfn_release) == napi_ok)
      return;
  } else if (queued == napi_queue_full) {
    // One producer/one frame makes this impossible in the normal transaction.
    // Abort a valid full queue, but never release after napi_closing: Push has
    // already surrendered this producer's thread count in that case.
    napi_release_threadsafe_function(completion->function, napi_tsfn_abort);
  }
  completion->disposal_failed = true;
  completion->task->owner->call_disposal_failed = true;
  try {
    completion->task->owner->fail();
  } catch (...) { /* No certificate. */
  }
}
static void drop_call_fds(const std::shared_ptr<CallData> &task,
                          std::vector<std::string> &retained) noexcept {
  for (auto &token : retained) {
    try {
      task->owner->drop(token);
    } catch (...) { /* Close may own the FD. */
    }
  }
  retained.clear();
}
static napi_value call_result(napi_env env,
                              const std::shared_ptr<CallData> &task,
                              std::vector<std::string> &retained) {
  if (task->failure)
    throw Failure(task->failure);
  if (task->owner->closing || g_cancellable_is_cancelled(task->cancel))
    throw Failure("CANCELLED");
  if (g_get_monotonic_time() >= task->expires_at)
    throw Failure("TIMEOUT");
  try {
    auto result = object(env);
    put(env, result, "connection", string(env, task->owner->id));
    put(env, result, "id", string(env, task->id));
    put(env, result, "sender",
        string(env, g_dbus_message_get_sender(task->response)));
    put(env, result, "signature", string(env, task->expected));
    put(env, result, "body",
        body_to_js(env, g_dbus_message_get_body(task->response),
                   g_dbus_message_get_unix_fd_list(task->response),
                   [&](int fd) {
                     auto token = task->owner->retain(fd);
                     try {
                       retained.push_back(token);
                     } catch (...) {
                       try {
                         task->owner->drop(token);
                       } catch (...) { /* Close may already own the FD. */
                       }
                       throw;
                     }
                     return token;
                   }));
    return result;
  } catch (...) {
    drop_call_fds(task, retained);
    throw;
  }
}
static napi_value call(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 2);
    auto task = std::make_shared<CallData>();
    task->owner = state(env, args[0]);
    auto request = args[1];
    fields(env, request,
           {"id", "destination", "path", "interface", "member",
            "inputSignature", "outputSignature", "body", "timeoutMs",
            "noAutoStart"});
    task->id = string(env, get(env, request, "id"), 36);
    check(is_uuid(task->id));
    task->destination = string(env, get(env, request, "destination"), 255);
    check(g_dbus_is_unique_name(task->destination.c_str()) ||
          task->destination == "org.freedesktop.DBus");
    task->path = string(env, get(env, request, "path"), 1024);
    check(g_variant_is_object_path(task->path.c_str()));
    task->interface = string(env, get(env, request, "interface"), 255);
    check(g_dbus_is_interface_name(task->interface.c_str()));
    task->member = string(env, get(env, request, "member"), 255);
    check(g_dbus_is_member_name(task->member.c_str()));
    auto input_type = string(env, get(env, request, "inputSignature"), 128);
    signature(input_type);
    task->expected = string(env, get(env, request, "outputSignature"), 128);
    signature(task->expected);
    double timeout = number(env, get(env, request, "timeoutMs"));
    check(timeout >= 1 && timeout <= 5000 && std::trunc(timeout) == timeout);
    task->timeout = static_cast<int>(timeout);
    check(boolean(env, get(env, request, "noAutoStart")));
    task->body = body_from_js(env, get(env, request, "body"), task->input,
                              [task](const std::string &token) {
                                return task->owner->duplicate(token);
                              });
    check(body_signature(task->body.get()) == input_type);
    {
      std::lock_guard<std::mutex> guard(task->owner->mutex);
      if (task->owner->closing)
        throw Failure("CLOSED");
      check(task->owner->calls.size() < 8 &&
            !task->owner->calls.count(task->id));
      task->expires_at = g_get_monotonic_time() + task->timeout * 1000LL;
      task->owner->calls.emplace(task->id, task->cancel);
    }
    napi_value promise;
    auto completion = std::make_shared<CallCompletion>();
    completion->task = task;
    completion->retirement = task->owner->retirement;
    ok(napi_create_promise(env, &completion->deferred, &promise));
    auto holder = std::make_unique<std::shared_ptr<CallCompletion>>(completion);
    ok(napi_create_threadsafe_function(
        env, nullptr, nullptr, string(env, "OpenWhisperLinuxBusCall"), 1, 1,
        holder.get(),
        [](napi_env, void *pointer, void *) {
          std::unique_ptr<std::shared_ptr<CallCompletion>> holder(
              static_cast<std::shared_ptr<CallCompletion> *>(pointer));
          auto retirement = (*holder)->retirement;
          const bool failed = (*holder)->disposal_failed || !(*holder)->settled;
          holder.reset(); // Release JS holder/resources before certification.
          if (failed && !retirement->environment->cleaning)
            retirement->failed = true;
          --retirement->callbacks;
          finish_retirement(retirement);
        },
        completion.get(),
        [](napi_env current, napi_value, void *pointer, void *) {
          auto *completion = static_cast<CallCompletion *>(pointer);
          auto environment = completion->retirement->environment;
          if (!current || environment->cleaning || !environment->module)
            return;
          std::vector<std::string> retained;
          try {
            auto value = call_result(current, completion->task, retained);
            if (completion->task->owner->closing ||
                g_cancellable_is_cancelled(completion->task->cancel))
              throw Failure("CANCELLED");
            if (g_get_monotonic_time() >= completion->task->expires_at)
              throw Failure("TIMEOUT");
            ok(napi_resolve_deferred(current, completion->deferred, value));
            completion->settled = true;
          } catch (const Failure &failure) {
            drop_call_fds(completion->task, retained);
            try {
              completion->settled =
                  napi_reject_deferred(current, completion->deferred,
                                       error(current, failure.what())) ==
                  napi_ok;
            } catch (...) {
              completion->disposal_failed = true;
            }
          } catch (...) {
            drop_call_fds(completion->task, retained);
            try {
              completion->settled =
                  napi_reject_deferred(current, completion->deferred,
                                       error(current, "INVALID_FRAME")) ==
                  napi_ok;
            } catch (...) {
              completion->disposal_failed = true;
            }
          }
        },
        &completion->function));
    ++completion->retirement->callbacks;
    holder.release(); // Successful TSFN finalization owns this shared holder.
    try {
      auto lifetime = std::make_shared<ContextCall>(task->owner);
      {
        std::lock_guard<std::mutex> guard(task->owner->mutex);
        if (task->owner->closing)
          throw Failure("CLOSED");
        ++task->owner->context_calls;
        lifetime->admitted = true;
      }
      auto start = std::make_unique<ContextCallJob>(
          ContextCallJob{lifetime, completion});
      // No lifecycle lock/future or libuv response-wait job on the JS thread.
      g_main_context_invoke_full(
          task->owner->context, G_PRIORITY_DEFAULT,
          [](gpointer pointer) -> gboolean {
            auto *job = static_cast<ContextCallJob *>(pointer);
            auto completion = job->completion;
            auto task = completion->task;
            try {
              if (task->owner->closing)
                throw Failure("CLOSED");
              if (g_cancellable_is_cancelled(task->cancel))
                throw Failure("CANCELLED");
              const gint64 remaining =
                  task->expires_at - g_get_monotonic_time();
              if (remaining <= 0)
                throw Failure("TIMEOUT");
              const int timeout = static_cast<int>((remaining + 999) / 1000);
              auto response = std::make_unique<ContextCallJob>(
                  ContextCallJob{job->lifetime, completion});
              GDBusMessage *message = g_dbus_message_new_method_call(
                  task->destination.c_str(), task->path.c_str(),
                  task->interface.c_str(), task->member.c_str());
              if (!message)
                throw Invalid();
              g_dbus_message_set_flags(message,
                                       G_DBUS_MESSAGE_FLAGS_NO_AUTO_START);
              g_dbus_message_set_body(message, task->body.get());
              if (g_unix_fd_list_get_length(task->input))
                g_dbus_message_set_unix_fd_list(message, task->input);
              g_dbus_connection_send_message_with_reply(
                  task->owner->connection, message,
                  G_DBUS_SEND_MESSAGE_FLAGS_NONE, timeout, nullptr,
                  task->cancel,
                  [](GObject *connection, GAsyncResult *result,
                     gpointer pointer) {
                    std::unique_ptr<ContextCallJob> job(
                        static_cast<ContextCallJob *>(pointer));
                    auto completion = job->completion;
                    auto task = completion->task;
                    const char *failure = nullptr;
                    GError *error = nullptr;
                    task->response =
                        g_dbus_connection_send_message_with_reply_finish(
                            G_DBUS_CONNECTION(connection), result, &error);
                    if (error) {
                      failure = g_error_matches(error, G_IO_ERROR,
                                                G_IO_ERROR_CANCELLED)
                                    ? "CANCELLED"
                                : g_error_matches(error, G_IO_ERROR,
                                                  G_IO_ERROR_TIMED_OUT)
                                    ? "TIMEOUT"
                                    : "TRANSPORT_FAILED";
                      g_error_free(error);
                    } else {
                      try {
                        if (!task->response || task->owner->closing)
                          throw Failure("CLOSED");
                        if (g_get_monotonic_time() >= task->expires_at)
                          throw Failure("TIMEOUT");
                        if (g_dbus_message_get_message_type(task->response) ==
                            G_DBUS_MESSAGE_TYPE_ERROR)
                          throw Failure("REMOTE_ERROR");
                        check(g_dbus_message_get_message_type(task->response) ==
                              G_DBUS_MESSAGE_TYPE_METHOD_RETURN);
                        const char *sender =
                            g_dbus_message_get_sender(task->response);
                        check(sender && task->destination == sender);
                        check(body_signature(g_dbus_message_get_body(
                                  task->response)) == task->expected);
                        check(g_dbus_message_get_num_unix_fds(task->response) <=
                              max_fds);
                      } catch (const Failure &value) {
                        failure = !std::strcmp(value.what(), "TIMEOUT")
                                      ? "TIMEOUT"
                                  : !std::strcmp(value.what(), "REMOTE_ERROR")
                                      ? "REMOTE_ERROR"
                                      : "CLOSED";
                      } catch (...) {
                        failure = "INVALID_FRAME";
                      }
                    }
                    finish_call(completion, failure);
                    // Locals release before job; job releases completion before
                    // its lease. Context drain therefore needs no JS
                    // settlement.
                  },
                  response.release());
              g_object_unref(message);
            } catch (const Failure &value) {
              finish_call(completion, !std::strcmp(value.what(), "TIMEOUT")
                                          ? "TIMEOUT"
                                      : !std::strcmp(value.what(), "CANCELLED")
                                          ? "CANCELLED"
                                          : "CLOSED");
            } catch (...) {
              finish_call(completion, "TRANSPORT_FAILED");
            }
            return G_SOURCE_REMOVE;
          },
          start.release(), // GLib owns the holder before it may invoke/destroy it.
          [](gpointer pointer) {
            delete static_cast<ContextCallJob *>(pointer);
          });
    } catch (const Failure &) {
      finish_call(completion, "CLOSED");
    } catch (...) {
      finish_call(completion, "TRANSPORT_FAILED");
    }
    return promise;
  });
}
static napi_value cancel(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 2);
    auto owner = state(env, args[0], true);
    auto id = string(env, args[1], 36);
    check(is_uuid(id));
    std::lock_guard<std::mutex> guard(owner->mutex);
    auto found = owner->calls.find(id);
    if (found != owner->calls.end())
      g_cancellable_cancel(found->second);
    return undefined(env);
  });
}
static Callback *callback(napi_env env, napi_value function,
                          const std::shared_ptr<State> &owner) {
  napi_valuetype kind;
  ok(napi_typeof(env, function, &kind));
  check(kind == napi_function);
  auto holder =
      std::make_unique<Callback>(Callback{nullptr, owner, owner->retirement});
  auto *result = holder.get();
  ok(napi_create_threadsafe_function(
      env, function, nullptr, string(env, "OpenWhisperLinuxBusEvent"), 32, 1,
      result,
      [](napi_env, void *pointer, void *) {
        std::unique_ptr<Callback> finalized(static_cast<Callback *>(pointer));
        auto retirement = finalized->retirement;
        finalized.reset();
        --retirement->callbacks;
        finish_retirement(retirement);
      },
      result,
      [](napi_env current, napi_value js, void *context, void *pointer) {
        std::unique_ptr<Event> event(static_cast<Event *>(pointer));
        auto *handler = static_cast<Callback *>(context);
        auto owner = handler->state.lock();
        if (!current || !js || !owner)
          return;
        auto environment = owner->retirement->environment;
        if (environment->cleaning || !environment->module)
          return;
        try {
          if (owner->closing)
            throw Failure("CLOSED");
          auto frame = object(current);
          put(current, frame, "kind", string(current, event->kind));
          put(current, frame, "connection", string(current, owner->id));
          put(current, frame, "id", string(current, event->id));
          if (event->kind == "method")
            put(current, frame, "expiresAtUs",
                string(current, std::to_string(event->expires_at)));
          put(current, frame, "sender", string(current, event->sender));
          put(current, frame, "path", string(current, event->path));
          put(current, frame, "interface", string(current, event->interface));
          put(current, frame, "member", string(current, event->member));
          put(current, frame, "signature",
              string(current, body_signature(event->body.get())));
          put(current, frame, "body",
              body_to_js(current, event->body.get(), nullptr,
                         [](int fd) -> std::string {
                           ::close(fd);
                           throw Invalid();
                         }));
          napi_value ignored;
          ok(napi_call_function(current, undefined(current), js, 1, &frame,
                                &ignored));
        } catch (...) {
          owner->fail();
          // One queued callback can still notify the TS owner after queue
          // overflow. It contains no remote payload and causes disposal.
          bool pending = false;
          napi_is_exception_pending(current, &pending);
          if (pending) {
            napi_value ignored;
            napi_get_and_clear_last_exception(current, &ignored);
          }
          try {
            auto frame = object(current);
            put(current, frame, "kind", string(current, "failure"));
            put(current, frame, "connection", string(current, owner->id));
            napi_value ignored;
            napi_call_function(current, undefined(current), js, 1, &frame,
                               &ignored);
          } catch (...) { /* Utility supervision is the final owner. */
          }
        }
      },
      &result->function));
  ++owner->retirement->callbacks;
  holder.release(); // Only the TSFN finalizer owns the successful holder.
  if (napi_unref_threadsafe_function(env, result->function) != napi_ok) {
    abort_callback(result);
    throw Invalid();
  }
  return result;
}
static void deliver(Callback *handler, Event *event) {
  if (napi_call_threadsafe_function(handler->function, event,
                                    napi_tsfn_nonblocking) != napi_ok) {
    delete event;
    if (auto owner = handler->state.lock())
      owner->fail();
  }
}
static napi_value subscribe(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 3);
    auto owner = state(env, args[0]);
    auto filter = args[1];
    fields(env, filter, {"sender", "path", "interface", "member"});
    auto sender = string(env, get(env, filter, "sender"), 255),
         path = string(env, get(env, filter, "path"), 1024),
         interface = string(env, get(env, filter, "interface"), 255),
         member = string(env, get(env, filter, "member"), 255);
    check(g_dbus_is_unique_name(sender.c_str()) ||
          sender == "org.freedesktop.DBus");
    check(g_variant_is_object_path(path.c_str()) &&
          g_dbus_is_interface_name(interface.c_str()) &&
          g_dbus_is_member_name(member.c_str()));
    auto id = uuid();
    auto *handler = callback(env, args[2], owner);
    return async(
        env,
        [owner, id, sender, path, interface, member, handler] {
          try {
            owner->in_context([&] {
              if (owner->closing)
                throw Failure("CLOSED");
              check(owner->subscriptions.size() < 16);
              guint token = g_dbus_connection_signal_subscribe(
                  owner->connection, sender.c_str(), interface.c_str(),
                  member.c_str(), path.c_str(), nullptr,
                  G_DBUS_SIGNAL_FLAGS_NONE,
                  [](GDBusConnection *, const gchar *actual_sender,
                     const gchar *actual_path, const gchar *actual_interface,
                     const gchar *actual_member, GVariant *parameters,
                     gpointer pointer) {
                    auto *target = static_cast<Callback *>(pointer);
                    if (g_variant_get_size(parameters) > max_bytes) {
                      if (auto owner = target->state.lock())
                        owner->fail();
                      auto *failure = new Event(nullptr);
                      failure->kind = "failure";
                      deliver(target, failure);
                      return;
                    }
                    auto event = std::make_unique<Event>(parameters);
                    event->kind = "signal";
                    event->id = "";
                    event->sender = actual_sender ? actual_sender : "";
                    event->path = actual_path;
                    event->interface = actual_interface;
                    event->member = actual_member;
                    deliver(target, event.release());
                  },
                  handler, nullptr);
              check(token != 0);
              owner->subscriptions.emplace(id, std::make_pair(token, handler));
            });
          } catch (...) {
            abort_callback(handler);
            throw;
          }
        },
        [env, id] { return string(env, id); });
  });
}
static napi_value unsubscribe(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 2);
    auto owner = state(env, args[0]);
    auto id = string(env, args[1], 36);
    check(is_uuid(id));
    return async(
        env,
        [owner, id] {
          owner->in_context([&] {
            auto found = owner->subscriptions.find(id);
            if (found == owner->subscriptions.end())
              throw Failure("INVALID_SUBSCRIPTION");
            g_dbus_connection_signal_unsubscribe(owner->connection,
                                                 found->second.first);
            abort_callback(found->second.second);
            owner->subscriptions.erase(found);
          });
        },
        [env] { return undefined(env); });
  });
}
// This static descriptor is packaged policy, never renderer-provided XML.
constexpr char control_xml[] =
    "<node><interface name='io.github.whisperfree.Control1'><method "
    "name='Status'><arg type='s' direction='out'/></method><method "
    "name='Execute'><arg type='s' direction='in'/><arg type='s' "
    "direction='out'/></method></interface></node>";
static void discard_invocation(State *owner, const std::string &id) {
  auto found = owner->invocations.find(id);
  if (found != owner->invocations.end()) {
    g_object_unref(found->second.method);
    owner->invocations.erase(found);
  }
  auto expiry = owner->expiries.find(id);
  if (expiry != owner->expiries.end()) {
    g_source_destroy(expiry->second);
    g_source_unref(expiry->second);
    owner->expiries.erase(expiry);
  }
}
// Acceptance means a reply queued under these local gates, not remote receipt.
static void send_control_reply(State *owner, const std::string &id,
                               GVariant *body,
                               const std::string &category = "") {
  if (owner->closing || g_dbus_connection_is_closed(owner->connection))
    throw Failure("CLOSED");
  auto found = owner->invocations.find(id);
  if (found == owner->invocations.end())
    throw Failure("EXPIRED");
  GDBusMessage *request =
      g_dbus_method_invocation_get_message(found->second.method);
  GDBusMessage *response =
      category.empty()
          ? g_dbus_message_new_method_reply(request)
          : g_dbus_message_new_method_error_literal(
                request, ("io.github.whisperfree.Error." + category).c_str(),
                category.c_str());
  if (category.empty())
    g_dbus_message_set_body(response, body);
  // Check the real monotonic clock at send even if the expiry source is ready
  // but has not dispatched. Unique-name loss removes the retained invocation
  // on this same context; no unbounded caller cache is kept.
  if (owner->closing || g_dbus_connection_is_closed(owner->connection) ||
      g_get_monotonic_time() >= found->second.expires_at) {
    g_object_unref(response);
    discard_invocation(owner, id);
    throw Failure("EXPIRED");
  }
  GError *error = nullptr;
  const gboolean queued = g_dbus_connection_send_message(
      owner->connection, response, G_DBUS_SEND_MESSAGE_FLAGS_NONE, nullptr,
      &error);
  g_object_unref(response);
  discard_invocation(owner, id);
  if (error)
    g_error_free(error);
  if (!queued)
    throw Failure("CLOSED");
}
static void control_method(GDBusConnection *, const gchar *sender,
                           const gchar *path, const gchar *interface,
                           const gchar *member, GVariant *parameters,
                           GDBusMethodInvocation *invocation,
                           gpointer pointer) {
  auto *owner = static_cast<State *>(pointer);
  if (owner->closing || owner->invocations.size() >= 8 || !sender ||
      !g_dbus_is_unique_name(sender) ||
      (g_dbus_message_get_flags(
           g_dbus_method_invocation_get_message(invocation)) &
       G_DBUS_MESSAGE_FLAGS_NO_REPLY_EXPECTED) ||
      g_variant_get_size(parameters) > max_bytes) {
    g_dbus_method_invocation_return_dbus_error(
        invocation, "io.github.whisperfree.Error.Unavailable", "Unavailable");
    return;
  }
  auto id = uuid();
  const gint64 expires_at = g_get_monotonic_time() + 3000000;
  owner->invocations.emplace(
      id, Invocation{G_DBUS_METHOD_INVOCATION(g_object_ref(invocation)), sender,
                     expires_at});
  auto event = std::make_unique<Event>(parameters);
  event->kind = "method";
  event->expires_at = expires_at;
  event->id = id;
  event->sender = sender;
  event->path = path;
  event->interface = interface;
  event->member = member;
  deliver(owner->export_callback, event.release());
  struct Expiry {
    std::weak_ptr<State> owner;
    std::string id;
  };
  auto *expiry = new Expiry{owner->shared_from_this(), id};
  GSource *timeout = g_timeout_source_new(3000);
  g_source_set_ready_time(timeout, expires_at);
  g_source_set_callback(
      timeout,
      [](gpointer pointer) -> gboolean {
        auto *value = static_cast<Expiry *>(pointer);
        if (auto owner = value->owner.lock()) {
          auto found = owner->invocations.find(value->id);
          if (found != owner->invocations.end()) {
            g_dbus_method_invocation_return_dbus_error(
                found->second.method, "io.github.whisperfree.Error.Expired",
                "Expired");
            g_object_unref(found->second.method);
            owner->invocations.erase(found);
          }
          auto timer = owner->expiries.find(value->id);
          if (timer != owner->expiries.end()) {
            g_source_unref(timer->second);
            owner->expiries.erase(timer);
          }
        }
        return G_SOURCE_REMOVE;
      },
      expiry, [](gpointer pointer) { delete static_cast<Expiry *>(pointer); });
  g_source_attach(timeout, owner->context);
  owner->expiries.emplace(id, timeout);
}
static napi_value export_control(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 2);
    auto owner = state(env, args[0]);
    auto *handler = callback(env, args[1], owner);
    return async(
        env,
        [owner, handler] {
          try {
            owner->in_context([&] {
              if (owner->closing || owner->export_id)
                throw Failure("CLOSED");
              owner->control_owner_subscription =
                  g_dbus_connection_signal_subscribe(
                      owner->connection, "org.freedesktop.DBus",
                      "org.freedesktop.DBus", "NameOwnerChanged",
                      "/org/freedesktop/DBus", nullptr,
                      G_DBUS_SIGNAL_FLAGS_NONE,
                      [](GDBusConnection *, const gchar *sender, const gchar *,
                         const gchar *, const gchar *, GVariant *parameters,
                         gpointer pointer) {
                        auto *current = static_cast<State *>(pointer);
                        if (!sender ||
                            std::strcmp(sender, "org.freedesktop.DBus") ||
                            !g_variant_is_of_type(parameters,
                                                  G_VARIANT_TYPE("(sss)")))
                          return;
                        const gchar *name, *before, *after;
                        g_variant_get(parameters, "(&s&s&s)", &name, &before,
                                      &after);
                        if (!g_dbus_is_unique_name(name) ||
                            std::strcmp(name, before) || *after)
                          return;
                        std::vector<std::string> invalid;
                        for (const auto &item : current->invocations)
                          if (item.second.sender == name)
                            invalid.push_back(item.first);
                        for (const auto &id : invalid)
                          discard_invocation(current, id);
                      },
                      owner.get(), nullptr);
              check(owner->control_owner_subscription != 0);
              GError *failure = nullptr;
              auto *xml = g_dbus_node_info_new_for_xml(control_xml, &failure);
              if (failure) {
                g_error_free(failure);
                throw Invalid();
              }
              static const GDBusInterfaceVTable vtable{
                  control_method, nullptr, nullptr, {nullptr}};
              owner->export_id = g_dbus_connection_register_object(
                  owner->connection, "/io/github/whisperfree/dev/Control",
                  xml->interfaces[0], &vtable, owner.get(), nullptr, &failure);
              g_dbus_node_info_unref(xml);
              if (failure) {
                g_error_free(failure);
                throw Failure("EXPORT_FAILED");
              }
              check(owner->export_id != 0);
              owner->export_callback = handler;
            });
          } catch (...) {
            abort_callback(handler);
            throw;
          }
        },
        [env] { return undefined(env); });
  });
}
static napi_value reply(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 3);
    auto owner = state(env, args[0]);
    auto id = string(env, args[1], 36);
    check(is_uuid(id));
    auto fds = std::shared_ptr<GUnixFDList>(
        g_unix_fd_list_new(), [](GUnixFDList *item) { g_object_unref(item); });
    auto body = std::make_shared<Variant>(body_from_js(
        env, args[2], fds.get(),
        [owner](const std::string &token) { return owner->duplicate(token); }));
    check(body_signature(body->get()) == "s" &&
          g_unix_fd_list_get_length(fds.get()) == 0);
    return async(
        env,
        [owner, id, body] {
          owner->in_context(
              [&] { send_control_reply(owner.get(), id, body->get()); });
        },
        [env] { return undefined(env); });
  });
}
static napi_value read_fd(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 2);
    auto owner = state(env, args[0]);
    auto token = string(env, args[1], 36);
    check(is_uuid(token));
    auto bytes = std::make_shared<std::vector<char>>();
    int descriptor = owner->duplicate(token);
    // Consume the holder before scheduling. Even failed reads cannot leave a
    // remotely supplied descriptor retained in the helper.
    owner->drop(token);
    auto fd = std::shared_ptr<int>(new int(descriptor), [](int *value) {
      ::close(*value);
      delete value;
    });
    return async(
        env,
        [bytes, fd, owner] {
          struct stat metadata{};
          if (owner->closing || fstat(*fd, &metadata) < 0 ||
              !S_ISREG(metadata.st_mode) || metadata.st_size < 0 ||
              metadata.st_size > 1048576)
            throw Failure("INVALID_FD");
          bytes->resize(static_cast<size_t>(metadata.st_size));
          size_t position = 0;
          while (position < bytes->size()) {
            if (owner->closing)
              throw Failure("CLOSED");
            ssize_t count =
                pread(*fd, bytes->data() + position, bytes->size() - position,
                      static_cast<off_t>(position));
            if (count <= 0)
              throw Failure("INVALID_FD");
            position += static_cast<size_t>(count);
          }
        },
        [env, owner, bytes] {
          if (owner->closing)
            throw Failure("CLOSED");
          napi_value result;
          void *copied = nullptr;
          ok(napi_create_buffer_copy(env, bytes->size(), bytes->data(), &copied,
                                     &result));
          return result;
        });
  });
}
static napi_value close_fd(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 2);
    state(env, args[0])->drop(string(env, args[1], 36));
    return undefined(env);
  });
}
static napi_value close(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 1);
    auto owner = state(env, args[0], true);
    return begin_close(env, owner, true);
  });
}
static napi_value reject(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto args = arguments(env, info, 3);
    auto owner = state(env, args[0]);
    auto id = string(env, args[1], 36);
    auto category = string(env, args[2], 20);
    check(is_uuid(id));
    check(category == "Denied" || category == "Busy" || category == "Expired" ||
          category == "InvalidRequest" || category == "Unavailable");
    return async(
        env,
        [owner, id, category] {
          owner->in_context(
              [&] { send_control_reply(owner.get(), id, nullptr, category); });
        },
        [env] { return undefined(env); });
  });
}
static napi_value initialize(napi_env env, napi_value exports) {
  return guarded(env, [&] {
    auto *value = new Module(env);
    ok(napi_set_instance_data(
        env, value,
        [](napi_env, void *pointer, void *) {
          delete static_cast<Module *>(pointer);
        },
        nullptr));
    auto cleanup = std::make_unique<std::shared_ptr<Environment>>(value->environment);
    ok(napi_add_env_cleanup_hook(
        env,
        [](void *pointer) {
          std::unique_ptr<std::shared_ptr<Environment>> lifetime(
              static_cast<std::shared_ptr<Environment> *>(pointer));
          (*lifetime)->cleaning = true;
          if ((*lifetime)->module)
            (*lifetime)->module->cleanup();
        }, cleanup.get()));
    cleanup.release();
    const napi_property_descriptor methods[] = {
        {"open", nullptr, open, nullptr, nullptr, nullptr, napi_default,
         nullptr},
        {"beginOpen", nullptr, begin_open, nullptr, nullptr, nullptr, napi_default,
         nullptr},
        {"call", nullptr, call, nullptr, nullptr, nullptr, napi_default,
         nullptr},
        {"cancel", nullptr, cancel, nullptr, nullptr, nullptr, napi_default,
         nullptr},
        {"subscribe", nullptr, subscribe, nullptr, nullptr, nullptr,
         napi_default, nullptr},
        {"unsubscribe", nullptr, unsubscribe, nullptr, nullptr, nullptr,
         napi_default, nullptr},
        {"exportControl", nullptr, export_control, nullptr, nullptr, nullptr,
         napi_default, nullptr},
        {"reply", nullptr, reply, nullptr, nullptr, nullptr, napi_default,
         nullptr},
        {"reject", nullptr, reject, nullptr, nullptr, nullptr, napi_default,
         nullptr},
        {"readFd", nullptr, read_fd, nullptr, nullptr, nullptr, napi_default,
         nullptr},
        {"closeFd", nullptr, close_fd, nullptr, nullptr, nullptr, napi_default,
         nullptr},
        {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default,
         nullptr}};
    ok(napi_define_properties(env, exports,
                              sizeof(methods) / sizeof(methods[0]), methods));
    return exports;
  });
}
} // namespace owbus
NAPI_MODULE(NODE_GYP_MODULE_NAME, owbus::initialize)
