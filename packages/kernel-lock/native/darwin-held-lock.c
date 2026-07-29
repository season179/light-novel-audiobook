#include <sys/event.h>
#include <sys/file.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static long long monotonic_millis(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
  return (long long)value.tv_sec * 1000LL + value.tv_nsec / 1000000LL;
}

static int register_parent_and_stdin(int queue, pid_t owner_pid) {
  struct kevent changes[2];
  EV_SET(&changes[0], (uintptr_t)owner_pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT,
         NOTE_EXIT, 0, NULL);
  EV_SET(&changes[1], STDIN_FILENO, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, NULL);
  return kevent(queue, changes, 2, NULL, 0, NULL);
}

static bool owner_or_stdin_gone(int queue, pid_t owner_pid, int timeout_ms) {
  struct kevent event;
  struct timespec timeout = { .tv_sec = timeout_ms / 1000,
                              .tv_nsec = (long)(timeout_ms % 1000) * 1000000L };
  int count = kevent(queue, NULL, 0, &event, 1, &timeout);
  if (count < 0) return true;
  if (count == 0) return false;
  if (event.filter == EVFILT_PROC && event.ident == (uintptr_t)owner_pid) return true;
  if (event.filter == EVFILT_READ && (event.flags & EV_EOF) != 0) return true;
  return false;
}

static int hold_until_stdin_eof(void) {
  int queue = kqueue();
  if (queue < 0) return 70;
  struct kevent change;
  EV_SET(&change, STDIN_FILENO, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, NULL);
  if (kevent(queue, &change, 1, NULL, 0, NULL) < 0) return 70;
  for (;;) {
    struct kevent event;
    int count = kevent(queue, NULL, 0, &event, 1, NULL);
    if (count < 0) {
      if (errno == EINTR) continue;
      return 70;
    }
    if (count == 1 && event.filter == EVFILT_READ && (event.flags & EV_EOF) != 0) return 0;
  }
}

static int parse_nonnegative(const char *text, long long *result) {
  char *end = NULL;
  errno = 0;
  long long value = strtoll(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < 0) return -1;
  *result = value;
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 8) {
    fprintf(stderr, "usage: darwin-held-lock <path> <nonblock|bounded> <wait-ms> <conflict-code> <token> <owner-pid> <protocol>\n");
    return 64;
  }

  const char *path = argv[1];
  const char *mode = argv[2];
  const char *token = argv[5];
  const char *protocol = argv[7];
  long long wait_ms = 0;
  long long conflict_code = 0;
  long long owner_value = 0;
  if (parse_nonnegative(argv[3], &wait_ms) != 0 ||
      parse_nonnegative(argv[4], &conflict_code) != 0 || conflict_code < 1 || conflict_code > 255 ||
      parse_nonnegative(argv[6], &owner_value) != 0 || owner_value < 2 ||
      (strcmp(mode, "nonblock") != 0 && strcmp(mode, "bounded") != 0)) {
    fprintf(stderr, "invalid held-lock arguments\n");
    return 64;
  }
  pid_t owner_pid = (pid_t)owner_value;

  int queue = kqueue();
  if (queue < 0 || register_parent_and_stdin(queue, owner_pid) < 0) {
    perror("kqueue parent watch");
    return 70;
  }
  /* Closes the parent-death-during-spawn race after the NOTE_EXIT watch is installed. */
  if (getppid() != owner_pid) return 70;

  int descriptor = open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
  if (descriptor < 0) {
    perror("open lock file");
    return 70;
  }

  long long started = monotonic_millis();
  if (started < 0) return 70;
  for (;;) {
    if (flock(descriptor, LOCK_EX | LOCK_NB) == 0) break;
    if (errno != EWOULDBLOCK && errno != EAGAIN) {
      perror("flock");
      return 70;
    }
    long long elapsed = monotonic_millis() - started;
    if (strcmp(mode, "nonblock") == 0 || elapsed >= wait_ms) return (int)conflict_code;
    int remaining = (int)(wait_ms - elapsed);
    if (owner_or_stdin_gone(queue, owner_pid, remaining < 10 ? remaining : 10)) return 70;
  }

  pid_t holder_pid = fork();
  if (holder_pid < 0) {
    perror("fork");
    return 70;
  }
  if (holder_pid == 0) {
    close(queue);
    printf("%s %d %s\n", token, getpid(), protocol);
    fflush(stdout);
    int result = hold_until_stdin_eof();
    close(descriptor);
    return result;
  }

  for (;;) {
    int status = 0;
    pid_t waited = waitpid(holder_pid, &status, WNOHANG);
    if (waited == holder_pid) {
      close(descriptor);
      if (WIFEXITED(status)) return WEXITSTATUS(status);
      if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
      return 70;
    }
    if (waited < 0 && errno != EINTR) return 70;
    if (owner_or_stdin_gone(queue, owner_pid, 20)) {
      kill(holder_pid, SIGKILL);
      while (waitpid(holder_pid, NULL, 0) < 0 && errno == EINTR) {}
      close(descriptor);
      return 0;
    }
  }
}
