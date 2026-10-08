#include "codec.hpp"
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <fcntl.h>
#include <future>
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
static void deliver(Callback *handler, Event *event);
struct Deadline {
  std::mutex mutex;
  std::condition_variable clock;
  bool done = false;
  std::thread thread;
  Deadline(GCancellable *cancellation, int milliseconds)
      : thread([this, cancellation, milliseconds] {
          std::unique_lock<std::mutex> lock(mutex);
          if (!clock.wait_for(lock, std::chrono::milliseconds(milliseconds),
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
  std::atomic<bool> closing{false};
  GDBusConnection *connection = nullptr;
  GMainContext *context = nullptr;
  GMainLoop *loop = nullptr;
  std::thread thread;
  GCancellable *opening = g_cancellable_new();
  std::mutex mutex;
  std::recursive_mutex lifecycle;
  std::map<std::string, GCancellable *> calls;
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
    std::lock_guard<std::mutex> guard(mutex);
    if (closing || fds.size() >= max_fds ||
        fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) {
      ::close(fd);
      throw Failure("INVALID_FD");
    }
    auto token = uuid();
    fds.emplace(token, fd);
    return token;
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
  ~Module() {
    for (auto &item : states) {
      try {
        item.second->stop();
      } catch (...) { /* Process disposal is the final fence. */
      }
    }
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
  if (!disposed)
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
struct Job {
  napi_env env;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::function<void()> execute;
  std::function<napi_value()> complete;
  std::function<void()> failed;
  std::string failure;
};
static napi_value async(napi_env env, std::function<void()> execute,
                        std::function<napi_value()> complete,
                        std::function<void()> failed = {}) {
  auto *job = new Job{env,
                      nullptr,
                      nullptr,
                      std::move(execute),
                      std::move(complete),
                      std::move(failed),
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
          try {
            if (status != napi_ok && task->failure.empty())
              task->failure = "CANCELLED";
            if (task->failure.empty())
              ok(napi_resolve_deferred(current, task->deferred,
                                       task->complete()));
            else {
              if (task->failed)
                task->failed();
              ok(napi_reject_deferred(current, task->deferred,
                                      error(current, task->failure.c_str())));
            }
          } catch (const Failure &value) {
            if (task->failed)
              task->failed();
            napi_reject_deferred(current, task->deferred,
                                 error(current, value.what()));
          } catch (...) {
            if (task->failed)
              task->failed();
            napi_reject_deferred(current, task->deferred,
                                 error(current, "INVALID_FRAME"));
          }
          napi_delete_async_work(current, task->work);
        },
        job, &job->work));
    ok(napi_queue_async_work(env, job->work));
  } catch (...) {
    if (job->failed)
      job->failed();
    if (job->work)
      napi_delete_async_work(env, job->work);
    delete job;
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
static napi_value open(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    size_t count = 3;
    std::vector<napi_value> args(count);
    ok(napi_get_cb_info(env, info, &count, args.data(), nullptr, nullptr));
    check(count == 1 || count == 2);
    args.resize(count);
    auto address = string(env, args[0], 1024);
    check(address_valid(address));
    check(module(env)->states.empty());
    auto owner = std::make_shared<State>();
    if (count == 2)
      owner->lifecycle_callback = callback(env, args[1], owner);
    module(env)->states.emplace(owner->id, owner);
    return async(
        env,
        [owner, address] {
          std::lock_guard<std::recursive_mutex> lifetime(owner->lifecycle);
          if (owner->closing)
            throw Failure("CLOSED");
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
          std::mutex clock_mutex;
          std::condition_variable clock;
          bool finished = false;
          std::thread deadline([&] {
            std::unique_lock<std::mutex> guard(clock_mutex);
            if (!clock.wait_for(guard, std::chrono::seconds(5),
                                [&] { return finished; }))
              g_cancellable_cancel(owner->opening);
          });
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
          {
            std::lock_guard<std::mutex> guard(clock_mutex);
            finished = true;
          }
          clock.notify_one();
          deadline.join();
          g_object_unref(observer);
          if (failure) {
            const bool cancelled =
                g_error_matches(failure, G_IO_ERROR, G_IO_ERROR_CANCELLED);
            g_error_free(failure);
            throw Failure(cancelled ? "CANCELLED" : "CONNECT_FAILED");
          }
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
        [env, owner] { module(env)->states.erase(owner->id); });
  });
}
struct CallData {
  std::shared_ptr<State> owner;
  std::string id, destination, path, interface, member, expected;
  int timeout = 0;
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
      task->owner->calls.emplace(task->id, task->cancel);
    }
    return async(
        env,
        [task] {
          GDBusMessage *message = g_dbus_message_new_method_call(
              task->destination.c_str(), task->path.c_str(),
              task->interface.c_str(), task->member.c_str());
          if (!message) {
            throw Invalid();
          }
          g_dbus_message_set_flags(message, G_DBUS_MESSAGE_FLAGS_NO_AUTO_START);
          g_dbus_message_set_body(message, task->body.get());
          if (g_unix_fd_list_get_length(task->input))
            g_dbus_message_set_unix_fd_list(message, task->input);
          GError *failure = nullptr;
          task->response = g_dbus_connection_send_message_with_reply_sync(
              task->owner->connection, message, G_DBUS_SEND_MESSAGE_FLAGS_NONE,
              task->timeout, nullptr, task->cancel, &failure);
          g_object_unref(message);
          if (failure) {
            bool cancelled =
                     g_error_matches(failure, G_IO_ERROR, G_IO_ERROR_CANCELLED),
                 timeout =
                     g_error_matches(failure, G_IO_ERROR, G_IO_ERROR_TIMED_OUT);
            g_error_free(failure);
            throw Failure(cancelled ? "CANCELLED"
                          : timeout ? "TIMEOUT"
                                    : "TRANSPORT_FAILED");
          }
          if (!task->response || task->owner->closing)
            throw Failure("CLOSED");
          if (g_dbus_message_get_message_type(task->response) ==
              G_DBUS_MESSAGE_TYPE_ERROR)
            throw Failure("REMOTE_ERROR");
          check(g_dbus_message_get_message_type(task->response) ==
                G_DBUS_MESSAGE_TYPE_METHOD_RETURN);
          const char *sender = g_dbus_message_get_sender(task->response);
          check(sender && task->destination == sender);
          check(body_signature(g_dbus_message_get_body(task->response)) ==
                task->expected);
          check(g_dbus_message_get_num_unix_fds(task->response) <= max_fds);
        },
        [env, task] {
          if (task->owner->closing || g_cancellable_is_cancelled(task->cancel))
            throw Failure("CANCELLED");
          std::vector<std::string> retained;
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
                             retained.push_back(token);
                             return token;
                           }));
            return result;
          } catch (...) {
            for (auto &token : retained)
              task->owner->drop(token);
            throw;
          }
        });
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
  auto *result = new Callback{nullptr, owner};
  ok(napi_create_threadsafe_function(
      env, function, nullptr, string(env, "OpenWhisperLinuxBusEvent"), 32, 1,
      result,
      [](napi_env, void *pointer, void *) {
        delete static_cast<Callback *>(pointer);
      },
      result,
      [](napi_env current, napi_value js, void *context, void *pointer) {
        std::unique_ptr<Event> event(static_cast<Event *>(pointer));
        auto *handler = static_cast<Callback *>(context);
        auto owner = handler->state.lock();
        if (!current || !js || !owner)
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
  ok(napi_unref_threadsafe_function(env, result->function));
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
    owner->closing = true;
    g_cancellable_cancel(owner->opening);
    {
      std::lock_guard<std::mutex> guard(owner->mutex);
      for (auto &item : owner->calls)
        g_cancellable_cancel(item.second);
    }
    return async(
        env, [owner] { owner->stop(); },
        [env, owner] {
          module(env)->states.erase(owner->id);
          return undefined(env);
        });
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
    auto *value = new Module;
    ok(napi_set_instance_data(
        env, value,
        [](napi_env, void *pointer, void *) {
          delete static_cast<Module *>(pointer);
        },
        nullptr));
    const napi_property_descriptor methods[] = {
        {"open", nullptr, open, nullptr, nullptr, nullptr, napi_default,
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
