/* First-party lifetime-only candidate. It never loads the CUA SDK. */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#endif

static double now_ms(void) {
  struct timespec value;
  clock_gettime(CLOCK_MONOTONIC, &value);
  return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}

static int group_empty(void) {
#ifdef __APPLE__
  pid_t pids[4096];
  errno = 0;
  int count = proc_listpgrppids(getpid(), pids, sizeof(pids));
  if (count < 0 || (count == 0 && errno != 0) ||
      count >= (int)(sizeof(pids) / sizeof(pids[0]))) return 0;
  return count == 0;
#else
  return 0;
#endif
}

static void sdk_child(int gate, char **argv) {
  close(3);
  char permit = 0;
  ssize_t bytes;
  do bytes = read(gate, &permit, 1); while (bytes < 0 && errno == EINTR);
  close(gate);
  if (bytes != 1 || permit != 'G') _exit(72);
  char *environment[] = {
    "ELECTRON_RUN_AS_NODE=1", "CUA_TELEMETRY_ENABLED=0",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0", "PATH=/usr/bin:/bin", NULL
  };
  char *helper_args[] = {argv[1], argv[2], argv[3], argv[4], argv[5], argv[6], NULL};
  execve(argv[1], helper_args, environment);
  _exit(73);
}

int main(int argc, char **argv) {
  if (argc != 8 || getpgrp() != getpid()) return 2;
  char *end;
  long parent_group = strtol(argv[7], &end, 10);
  if (*end != '\0' || parent_group <= 0 || parent_group == getpid()) return 3;
  signal(SIGPIPE, SIG_IGN);
  if (fcntl(3, F_SETFD, FD_CLOEXEC) != 0) return 4;
  int gate[2];
  if (pipe(gate) != 0) return 5;
  pid_t helper = fork();
  if (helper < 0) return 6;
  if (helper == 0) {
    close(gate[1]);
    sdk_child(gate[0], argv);
  }
  close(gate[0]);
  // The gated child pins the new group while this live, waitable leader moves
  // outside the kill target. No SDK instruction can execute before this move.
  int moved = setpgid(0, (pid_t)parent_group) == 0;
  if (moved && getpgrp() != getpid()) {
    char permit = 'G';
    if (write(gate[1], &permit, 1) != 1) moved = 0;
  }
  close(gate[1]);
  double pulse = now_ms();
  int retiring = !moved;
  int exited = 0;
  int status = 0;
  int parent_open = 1;
  for (;;) {
    if (!exited) {
      pid_t waited = waitpid(helper, &status, WNOHANG);
      if (waited == helper) exited = 1;
      if (waited < 0) retiring = 1;
    }
    if (exited && (group_empty() || !moved))
      return WIFEXITED(status) ? WEXITSTATUS(status) : 70;
    if (exited || now_ms() - pulse > 5000) retiring = 1;
    if (retiring) {
      if (moved) {
        // A spawn already inside the kernel can outlive a single group signal.
        // The live guardian reserves this number and survives to re-signal.
        kill(-getpid(), SIGKILL);
      } else if (!exited) {
        // The gate never opened. Only this direct waitable child can exist.
        kill(helper, SIGKILL);
      }
    }
    struct pollfd fd = {.fd = 3, .events = POLLIN};
    int ready = poll(parent_open ? &fd : NULL, parent_open ? 1 : 0, 20);
    if (ready < 0 && errno != EINTR) retiring = 1;
    if (ready > 0) {
      char buffer[128];
      ssize_t count = read(3, buffer, sizeof(buffer));
      if (count <= 0) {
        retiring = 1;
        parent_open = 0;
        close(3);
      }
      else pulse = now_ms();
    }
  }
}
