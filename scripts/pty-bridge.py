#!/usr/bin/env python3
"""Bridge Node pipes to a real POSIX PTY on macOS.

The Node local agent communicates with this helper through ordinary stdin/stdout
pipes. The helper forks the requested command under a real pseudoterminal and
copies bytes in both directions. No credentials or command policy live here.
"""

from __future__ import annotations

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def set_initial_window_size(master_fd: int) -> None:
    try:
        rows = max(1, int(os.environ.get("LINES", "40")))
        cols = max(1, int(os.environ.get("COLUMNS", "120")))
        size = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, size)
    except (OSError, ValueError):
        pass


def main() -> int:
    if len(sys.argv) < 2:
        print("pty-bridge: missing command", file=sys.stderr)
        return 64

    command = sys.argv[1:]
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.execvpe(command[0], command, os.environ)
        raise AssertionError("exec returned unexpectedly")

    set_initial_window_size(master_fd)

    def forward_signal(signum: int, _frame: object) -> None:
        try:
            os.killpg(child_pid, signum)
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(child_pid, signum)
            except ProcessLookupError:
                pass

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, forward_signal)

    stdin_fd: int | None = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    while True:
        readers = [master_fd]
        if stdin_fd is not None:
            readers.append(stdin_fd)
        try:
            ready, _, _ = select.select(readers, [], [])
        except InterruptedError:
            continue

        if master_fd in ready:
            try:
                data = os.read(master_fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            write_all(stdout_fd, data)

        if stdin_fd is not None and stdin_fd in ready:
            data = os.read(stdin_fd, 65536)
            if not data:
                stdin_fd = None
            else:
                write_all(master_fd, data)

    try:
        _, status = os.waitpid(child_pid, 0)
    finally:
        os.close(master_fd)

    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
