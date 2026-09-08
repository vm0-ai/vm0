/* Diagnostic-only Node-API owner. No CUA bridge, libuv child, or blocking wait. */
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#endif

static pid_t child = 0;
static int control = -1;

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static void number(napi_env env, napi_value object, const char *key, int value) {
  napi_value result;
  napi_create_int32(env, value, &result);
  napi_set_named_property(env, object, key, result);
}

static int observe(siginfo_t *info) {
  memset(info, 0, sizeof(*info));
  if (child <= 0) return ECHILD;
  if (waitid(P_PID, (id_t)child, info, WEXITED | WNOHANG | WNOWAIT) != 0)
    return errno;
  return 0;
}

static int members(void) {
#ifdef __APPLE__
  pid_t pids[4096];
  errno = 0;
  int bytes = proc_listpgrppids((uint32_t)child, pids, sizeof(pids));
  if (bytes < 0 || (bytes == 0 && errno != 0)) return -1;
  if (bytes >= (int)sizeof(pids) || bytes % sizeof(pid_t) != 0) return -1;
  int count = 0;
  for (int i = 0; i < bytes / (int)sizeof(pid_t); ++i) {
    if (pids[i] != 0 && pids[i] != child) ++count;
  }
  return count;
#else
  return -1; /* Linux is compile-only; no substitute containment proof. */
#endif
}

static napi_value launch(napi_env env, napi_callback_info info) {
  if (child != 0) return fail(env, "ownership fence is retained");
  napi_value args[1];
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  uint32_t length;
  if (argc != 1 || napi_get_array_length(env, args[0], &length) != napi_ok ||
      length != 7) return fail(env, "expected seven diagnostic paths/options");
  char strings[7][PATH_MAX];
  char *argv[8];
  for (uint32_t i = 0; i < length; ++i) {
    napi_value value;
    size_t copied;
    napi_get_element(env, args[0], i, &value);
    if (napi_get_value_string_utf8(env, value, strings[i], PATH_MAX, &copied) !=
          napi_ok || copied == 0 || copied >= PATH_MAX - 1)
      return fail(env, "invalid diagnostic launch argument");
    argv[i] = strings[i];
  }
  argv[7] = NULL;
  int pipefd[2];
  if (pipe(pipefd) != 0) return fail(env, "lifetime pipe failed");
  fcntl(pipefd[0], F_SETFD, FD_CLOEXEC);
  fcntl(pipefd[1], F_SETFD, FD_CLOEXEC);
  fcntl(pipefd[1], F_SETFL, O_NONBLOCK);
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, pipefd[0], 3);
  if (pipefd[0] != 3) posix_spawn_file_actions_addclose(&actions, pipefd[0]);
  if (pipefd[1] != 3) posix_spawn_file_actions_addclose(&actions, pipefd[1]);
  posix_spawnattr_init(&attributes);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP);
  posix_spawnattr_setpgroup(&attributes, 0);
  char *environment[] = {"PATH=/usr/bin:/bin", NULL};
  int result = posix_spawn(&child, argv[0], &actions, &attributes, argv, environment);
  posix_spawnattr_destroy(&attributes);
  posix_spawn_file_actions_destroy(&actions);
  close(pipefd[0]);
  if (result != 0) {
    close(pipefd[1]);
    child = 0;
    return fail(env, "guardian spawn failed");
  }
  control = pipefd[1];
  napi_value output;
  napi_create_int32(env, child, &output);
  return output;
}

static napi_value pulse(napi_env env, napi_callback_info info) {
  (void)info;
  /* Ignore a broken lifetime channel; retirement must still prove exit. */
  char byte = 'H';
  if (control >= 0 && write(control, &byte, 1) < 0 && errno != EAGAIN &&
      errno != EINTR && errno != EPIPE) return fail(env, "heartbeat write failed");
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value force(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t argc = 1;
  int32_t expected;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  siginfo_t status;
  int result = -1;
  if (argc == 1 && napi_get_value_int32(env, args[0], &expected) == napi_ok &&
      expected == child && observe(&status) == 0) {
    result = kill(-child, SIGKILL);
  }
  napi_value value;
  napi_create_int32(env, result, &value);
  return value;
}

static napi_value sample(napi_env env, napi_callback_info info) {
  (void)info;
  siginfo_t status;
  int error = observe(&status);
  napi_value output;
  napi_create_object(env, &output);
  number(env, output, "pid", child);
  number(env, output, "waitError", error);
  number(env, output, "exited", error == 0 && status.si_pid == child);
  number(env, output, "exitCode", status.si_code);
  number(env, output, "exitStatus", status.si_status);
  number(env, output, "remaining", error == 0 ? members() : -1);
  return output;
}

static napi_value crash_guardian(napi_env env, napi_callback_info info) {
  (void)info;
  siginfo_t status;
  if (observe(&status) != 0 || status.si_pid != 0)
    return fail(env, "guardian identity is unavailable");
  napi_value value;
  napi_create_int32(env, kill(child, SIGKILL), &value);
  return value;
}

static napi_value reap(napi_env env, napi_callback_info info) {
  (void)info;
  siginfo_t status;
  if (observe(&status) != 0 || status.si_pid != child || members() != 0)
    return fail(env, "cleanup_unproven: child reservation retained");
  int code;
  if (waitpid(child, &code, WNOHANG) != child)
    return fail(env, "guardian reap failed");
  child = 0;
  close(control);
  control = -1;
  napi_value value;
  napi_create_int32(env, code, &value);
  return value;
}

static napi_value init(napi_env env, napi_value exports) {
  signal(SIGPIPE, SIG_IGN);
  napi_property_descriptor properties[] = {
    {"launch", NULL, launch, NULL, NULL, NULL, napi_default, NULL},
    {"pulse", NULL, pulse, NULL, NULL, NULL, napi_default, NULL},
    {"force", NULL, force, NULL, NULL, NULL, napi_default, NULL},
    {"sample", NULL, sample, NULL, NULL, NULL, napi_default, NULL},
    {"reap", NULL, reap, NULL, NULL, NULL, napi_default, NULL},
    {"crashGuardian", NULL, crash_guardian, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, 6, properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
