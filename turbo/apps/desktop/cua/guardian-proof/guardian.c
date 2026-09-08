/* First-party lifetime-only candidate. It never loads the CUA SDK. */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static double now_ms(void) {
  struct timespec value;
  clock_gettime(CLOCK_MONOTONIC, &value);
  return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}

static void expire(int signal_number) {
  (void)signal_number;
  /* This live leader pins the target, even after its parent has died. */
  kill(-getpid(), SIGKILL);
  _exit(71);
}

int main(int argc, char **argv) {
  if (argc != 7 || getpgrp() != getpid()) return 2;
  signal(SIGPIPE, SIG_IGN);
  signal(SIGALRM, expire);
  alarm(20); /* Diagnostic rescue only; never a five-second proof success. */
  if (fcntl(3, F_SETFD, FD_CLOEXEC) != 0) return 3;
  char *environment[] = {
    "ELECTRON_RUN_AS_NODE=1", "CUA_TELEMETRY_ENABLED=0",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0", "PATH=/usr/bin:/bin", NULL
  };
  char *helper_args[] = {argv[1], argv[2], argv[3], argv[4], argv[5], argv[6], NULL};
  pid_t helper;
  if (posix_spawn(&helper, argv[1], NULL, NULL, helper_args, environment) != 0)
    return 4;
  double pulse = now_ms();
  for (;;) {
    int status;
    pid_t waited = waitpid(helper, &status, WNOHANG);
    if (waited == helper) return WIFEXITED(status) ? WEXITSTATUS(status) : 70;
    if (waited < 0) expire(0);
    struct pollfd fd = {.fd = 3, .events = POLLIN};
    int ready = poll(&fd, 1, 20);
    if (ready < 0 && errno != EINTR) expire(0);
    if (ready > 0) {
      char buffer[128];
      ssize_t count = read(3, buffer, sizeof(buffer));
      if (count <= 0) expire(0);
      pulse = now_ms();
    }
    if (now_ms() - pulse > 1000) expire(0);
  }
}
