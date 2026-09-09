/* No tools, socket, permissions or capture. Independent test-only expiry. */
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void expire(int value) { (void)value; _exit(90); }

int main(int argc, char **argv) {
  const char *socket = NULL;
  for (int i = 1; i + 1 < argc; ++i)
    if (strcmp(argv[i], "--socket") == 0) socket = argv[i + 1];
  if (socket == NULL) return 2;
  signal(SIGTERM, SIG_IGN);
  signal(SIGALRM, expire);
  alarm(15);
  char name[1024], temporary[1024];
  if (snprintf(name, sizeof(name), "%s.daemon", socket) >= (int)sizeof(name)) return 3;
  if (snprintf(temporary, sizeof(temporary), "%s.tmp", name) >= (int)sizeof(temporary)) return 3;
  FILE *file = fopen(temporary, "wx");
  if (file == NULL) return 4;
  fprintf(file, "%d %d %d\n", getpid(), getppid(), getpgrp());
  if (fclose(file) != 0 || rename(temporary, name) != 0) return 5;
  for (;;) pause();
}
