/* Lifecycle-only Node-API owner. No CUA bridge, libuv child, or blocking wait. */
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
#include <sys/proc.h>
#include <sys/proc_info.h>
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

static int child_exited(const siginfo_t *info) {
  // Darwin may report CLD_STOPPED with this waitid flag combination. A
  // waitable event is not necessarily an exit and must never release ownership.
  return info->si_pid == child &&
    (info->si_code == CLD_EXITED || info->si_code == CLD_KILLED ||
     info->si_code == CLD_DUMPED);
}

static int members(void) {
#ifdef __APPLE__
  pid_t pids[4096];
  errno = 0;
  /* This convenience API returns a PID count, unlike proc_listpids (bytes). */
  int length = proc_listpgrppids(child, pids, sizeof(pids));
  if (length < 0 || (length == 0 && errno != 0)) return -1;
  if (length >= (int)(sizeof(pids) / sizeof(pids[0]))) return -1;
  int count = 0;
  for (int i = 0; i < length; ++i) {
    if (pids[i] != 0 && pids[i] != child) ++count;
  }
  return count;
#else
  return -1; /* Linux is compile-only; no substitute containment proof. */
#endif
}

/* A frozen guardian may retain its exited direct child as a zombie. Do not
 * destroy the remaining supervisor until every group member has exited. */
static int descendants_exited(void) {
#ifdef __APPLE__
  pid_t pids[4096];
  struct proc_bsdinfo snapshot[4096];
  errno = 0;
  int length = proc_listpgrppids(child, pids, sizeof(pids));
  if (length < 0 || (length == 0 && errno != 0) ||
      length >= (int)(sizeof(pids) / sizeof(pids[0]))) return 0;
  int recorded = 0;
  for (int i = 0; i < length; ++i) {
    if (pids[i] == 0 || pids[i] == child) continue;
    struct proc_bsdinfo *state = &snapshot[recorded];
    if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, state, sizeof(*state)) !=
        (int)sizeof(*state) || state->pbi_pid != (uint32_t)pids[i] ||
        state->pbi_pgid != (uint32_t)child || state->pbi_status != SZOMB) return 0;
    ++recorded;
  }
  // A fork already in progress may publish a child between enumeration and
  // its parent's exit. Require a second, closed set of the same exited birth
  // identities before removing the guardian. Any newly visible child keeps it.
  errno = 0;
  length = proc_listpgrppids(child, pids, sizeof(pids));
  if (length < 0 || (length == 0 && errno != 0) ||
      length >= (int)(sizeof(pids) / sizeof(pids[0]))) return 0;
  for (int i = 0; i < length; ++i) {
    if (pids[i] == 0 || pids[i] == child) continue;
    struct proc_bsdinfo state;
    if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &state, sizeof(state)) !=
        (int)sizeof(state) || state.pbi_pid != (uint32_t)pids[i] ||
        state.pbi_pgid != (uint32_t)child || state.pbi_status != SZOMB) return 0;
    int matched = 0;
    for (int j = 0; j < recorded; ++j) {
      if (state.pbi_pid == snapshot[j].pbi_pid &&
          state.pbi_start_tvsec == snapshot[j].pbi_start_tvsec &&
          state.pbi_start_tvusec == snapshot[j].pbi_start_tvusec) matched = 1;
    }
    if (!matched) return 0;
  }
  return 1;
#else
  return 0;
#endif
}

static napi_value launch(napi_env env, napi_callback_info info) {
  if (child != 0) return fail(env, "ownership fence is retained");
  napi_value args[1];
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  uint32_t length;
  if (argc != 1 || napi_get_array_length(env, args[0], &length) != napi_ok ||
      length != 7) return fail(env, "expected seven fixed launch arguments");
  char strings[7][PATH_MAX];
  char *argv[9];
  for (uint32_t i = 0; i < length; ++i) {
    napi_value value;
    size_t copied;
    napi_get_element(env, args[0], i, &value);
    if (napi_get_value_string_utf8(env, value, strings[i], PATH_MAX, &copied) !=
          napi_ok || copied == 0 || copied >= PATH_MAX - 1)
      return fail(env, "invalid fixed launch argument");
    argv[i] = strings[i];
  }
  char parent_group[32];
  snprintf(parent_group, sizeof(parent_group), "%d", getpgrp());
  argv[7] = parent_group;
  argv[8] = NULL;
  int pipefd[2];
  if (pipe(pipefd) != 0) return fail(env, "lifetime pipe failed");
  fcntl(pipefd[0], F_SETFD, FD_CLOEXEC);
  fcntl(pipefd[1], F_SETFD, FD_CLOEXEC);
  fcntl(pipefd[1], F_SETFL, O_NONBLOCK);
#ifdef __APPLE__
  if (fcntl(pipefd[1], F_SETNOSIGPIPE, 1) != 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    return fail(env, "lifetime pipe signal policy failed");
  }
#endif
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
    // Resume only this still-waitable stopped lifecycle owner so it can reap
    // its exited helper. It remains outside the SDK kill group and available
    // if main dies. Neither SIGCONT nor SIGKILL is evidence of completion.
    if (status.si_pid == child && status.si_code == CLD_STOPPED)
      kill(child, SIGCONT);
    result = kill(-child, SIGKILL);
    // Keep the guardian available if main dies during force. Only terminate
    // its retained PID once every SDK descendant is gone or kernel-exited.
    if (!child_exited(&status) && descendants_exited()) kill(child, SIGKILL);
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
  number(env, output, "exited", error == 0 && child_exited(&status));
  number(env, output, "exitCode", status.si_code);
  number(env, output, "exitStatus", status.si_status);
  number(env, output, "remaining", error == 0 ? members() : -1);
  return output;
}

#ifdef CUA_SUPERVISOR_TESTING
static napi_value stop_guardian(napi_env env, napi_callback_info info) {
  (void)info;
  siginfo_t status;
  if (observe(&status) != 0 || child_exited(&status))
    return fail(env, "guardian identity is unavailable");
  napi_value value;
  napi_create_int32(env, kill(child, SIGSTOP), &value);
  return value;
}

static napi_value crash_guardian(napi_env env, napi_callback_info info) {
  (void)info;
  siginfo_t status;
  if (observe(&status) != 0 || child_exited(&status))
    return fail(env, "guardian identity is unavailable");
  napi_value value;
  napi_create_int32(env, kill(child, SIGKILL), &value);
  return value;
}
#endif

static napi_value reap(napi_env env, napi_callback_info info) {
  (void)info;
  siginfo_t status;
  if (observe(&status) != 0 || !child_exited(&status) || members() != 0)
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
  napi_property_descriptor properties[] = {
    {"launch", NULL, launch, NULL, NULL, NULL, napi_default, NULL},
    {"pulse", NULL, pulse, NULL, NULL, NULL, napi_default, NULL},
    {"force", NULL, force, NULL, NULL, NULL, napi_default, NULL},
    {"sample", NULL, sample, NULL, NULL, NULL, napi_default, NULL},
    {"reap", NULL, reap, NULL, NULL, NULL, napi_default, NULL},
#ifdef CUA_SUPERVISOR_TESTING
    {"crashGuardian", NULL, crash_guardian, NULL, NULL, NULL, napi_default, NULL},
    {"stopGuardian", NULL, stop_guardian, NULL, NULL, NULL, napi_default, NULL},
#endif
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
