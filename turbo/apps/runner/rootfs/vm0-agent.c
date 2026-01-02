/*
 * vm0-agent: Minimal vsock daemon for Firecracker VM communication
 *
 * Compile: gcc -static -o vm0-agent vm0-agent.c
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <linux/vm_sockets.h>
#include <signal.h>
#include <errno.h>

#define VSOCK_PORT 5000
#define BUFFER_SIZE 65536

static volatile int running = 1;

void signal_handler(int sig) {
    running = 0;
}

/* Simple JSON string escaping */
void json_escape(const char *src, char *dst, size_t dst_size) {
    size_t i = 0, j = 0;
    while (src[i] && j < dst_size - 2) {
        if (src[i] == '"' || src[i] == '\\') {
            dst[j++] = '\\';
        } else if (src[i] == '\n') {
            dst[j++] = '\\';
            dst[j++] = 'n';
            i++;
            continue;
        } else if (src[i] == '\r') {
            dst[j++] = '\\';
            dst[j++] = 'r';
            i++;
            continue;
        } else if (src[i] == '\t') {
            dst[j++] = '\\';
            dst[j++] = 't';
            i++;
            continue;
        }
        if (j < dst_size - 1) {
            dst[j++] = src[i];
        }
        i++;
    }
    dst[j] = '\0';
}

/* Extract JSON string value for a key */
int json_get_string(const char *json, const char *key, char *value, size_t value_size) {
    char search[256];
    snprintf(search, sizeof(search), "\"%s\":", key);

    const char *start = strstr(json, search);
    if (!start) return -1;

    start += strlen(search);
    while (*start == ' ' || *start == '\t') start++;

    if (*start != '"') return -1;
    start++;

    size_t i = 0;
    while (start[i] && start[i] != '"' && i < value_size - 1) {
        if (start[i] == '\\' && start[i+1]) {
            i++;
            if (start[i] == 'n') value[i-1] = '\n';
            else if (start[i] == 'r') value[i-1] = '\r';
            else if (start[i] == 't') value[i-1] = '\t';
            else value[i-1] = start[i];
        } else {
            value[i] = start[i];
        }
        i++;
    }
    value[i] = '\0';
    return 0;
}

/* Handle ping request */
void handle_ping(int client_fd) {
    const char *response = "{\"type\":\"pong\"}";
    write(client_fd, response, strlen(response));
}

/* Handle exec request */
void handle_exec(int client_fd, const char *request) {
    char command[4096];
    if (json_get_string(request, "command", command, sizeof(command)) < 0) {
        const char *error = "{\"type\":\"error\",\"error\":\"No command provided\"}";
        write(client_fd, error, strlen(error));
        return;
    }

    int pipefd[2];
    if (pipe(pipefd) < 0) {
        const char *error = "{\"type\":\"error\",\"error\":\"Pipe creation failed\"}";
        write(client_fd, error, strlen(error));
        return;
    }

    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        const char *error = "{\"type\":\"error\",\"error\":\"Fork failed\"}";
        write(client_fd, error, strlen(error));
        return;
    }

    if (pid == 0) {
        /* Child process */
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[1]);

        execl("/bin/sh", "sh", "-c", command, NULL);
        exit(127);
    }

    /* Parent process */
    close(pipefd[1]);

    char output[32768] = {0};
    char buf[1024];
    size_t total = 0;
    ssize_t n;

    while ((n = read(pipefd[0], buf, sizeof(buf) - 1)) > 0) {
        if (total + n < sizeof(output) - 1) {
            memcpy(output + total, buf, n);
            total += n;
        }
    }
    output[total] = '\0';
    close(pipefd[0]);

    int status;
    waitpid(pid, &status, 0);
    int exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;

    /* Escape output for JSON */
    char escaped[65536];
    json_escape(output, escaped, sizeof(escaped));

    /* Build response */
    char response[131072];
    snprintf(response, sizeof(response),
        "{\"type\":\"result\",\"exitCode\":%d,\"stdout\":\"%s\",\"stderr\":\"\"}",
        exit_code, escaped);

    write(client_fd, response, strlen(response));
}

/* Handle write_file request */
void handle_write_file(int client_fd, const char *request) {
    char path[1024];
    char content[32768];

    if (json_get_string(request, "path", path, sizeof(path)) < 0) {
        const char *error = "{\"type\":\"error\",\"error\":\"No path provided\"}";
        write(client_fd, error, strlen(error));
        return;
    }

    if (json_get_string(request, "content", content, sizeof(content)) < 0) {
        content[0] = '\0';
    }

    FILE *f = fopen(path, "w");
    if (!f) {
        char error[256];
        snprintf(error, sizeof(error),
            "{\"type\":\"error\",\"error\":\"Cannot open file: %s\"}", strerror(errno));
        write(client_fd, error, strlen(error));
        return;
    }

    fwrite(content, 1, strlen(content), f);
    fclose(f);

    const char *response = "{\"type\":\"result\"}";
    write(client_fd, response, strlen(response));
}

/* Handle read_file request */
void handle_read_file(int client_fd, const char *request) {
    char path[1024];

    if (json_get_string(request, "path", path, sizeof(path)) < 0) {
        const char *error = "{\"type\":\"error\",\"error\":\"No path provided\"}";
        write(client_fd, error, strlen(error));
        return;
    }

    FILE *f = fopen(path, "r");
    if (!f) {
        char error[256];
        snprintf(error, sizeof(error),
            "{\"type\":\"error\",\"error\":\"Cannot open file: %s\"}", strerror(errno));
        write(client_fd, error, strlen(error));
        return;
    }

    char content[32768] = {0};
    size_t len = fread(content, 1, sizeof(content) - 1, f);
    content[len] = '\0';
    fclose(f);

    char escaped[65536];
    json_escape(content, escaped, sizeof(escaped));

    char response[131072];
    snprintf(response, sizeof(response),
        "{\"type\":\"result\",\"content\":\"%s\"}", escaped);

    write(client_fd, response, strlen(response));
}

/* Handle client connection */
void handle_client(int client_fd) {
    char buffer[BUFFER_SIZE] = {0};
    ssize_t n = read(client_fd, buffer, sizeof(buffer) - 1);

    if (n <= 0) {
        return;
    }

    /* Find request type */
    char req_type[32] = {0};
    json_get_string(buffer, "type", req_type, sizeof(req_type));

    if (strcmp(req_type, "ping") == 0) {
        handle_ping(client_fd);
    } else if (strcmp(req_type, "exec") == 0) {
        handle_exec(client_fd, buffer);
    } else if (strcmp(req_type, "write_file") == 0) {
        handle_write_file(client_fd, buffer);
    } else if (strcmp(req_type, "read_file") == 0) {
        handle_read_file(client_fd, buffer);
    } else {
        char error[256];
        snprintf(error, sizeof(error),
            "{\"type\":\"error\",\"error\":\"Unknown request type: %s\"}", req_type);
        write(client_fd, error, strlen(error));
    }
}

int main() {
    printf("[vm0-agent] Starting vsock daemon on port %d\n", VSOCK_PORT);
    fflush(stdout);

    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);
    signal(SIGCHLD, SIG_IGN);  /* Prevent zombies */

    int server_fd = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (server_fd < 0) {
        perror("[vm0-agent] socket");
        return 1;
    }

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_vm addr = {
        .svm_family = AF_VSOCK,
        .svm_cid = VMADDR_CID_ANY,
        .svm_port = VSOCK_PORT,
    };

    if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("[vm0-agent] bind");
        close(server_fd);
        return 1;
    }

    if (listen(server_fd, 5) < 0) {
        perror("[vm0-agent] listen");
        close(server_fd);
        return 1;
    }

    printf("[vm0-agent] Listening on vsock port %d\n", VSOCK_PORT);
    fflush(stdout);

    while (running) {
        struct sockaddr_vm client_addr;
        socklen_t client_len = sizeof(client_addr);

        int client_fd = accept(server_fd, (struct sockaddr *)&client_addr, &client_len);
        if (client_fd < 0) {
            if (errno == EINTR) continue;
            perror("[vm0-agent] accept");
            continue;
        }

        printf("[vm0-agent] Connection from CID %u\n", client_addr.svm_cid);
        fflush(stdout);

        handle_client(client_fd);
        close(client_fd);
    }

    close(server_fd);
    printf("[vm0-agent] Shutdown\n");
    return 0;
}
