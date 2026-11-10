"""Drives a program in a pseudo-terminal from a list of steps and records everything it writes.

usage: drive.py STEPS.json OUTPUT.bin COLUMNS ROWS CWD -- COMMAND [ARGS...]
steps: [{"send": "text"}, {"expect": "regex", "timeout": 8}, {"sleep": 0.3}]
Exit code 0 when every step worked and the program ended; 3 when an expectation timed out.
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def main():
    steps_file, output_file, columns, rows, cwd = sys.argv[1:6]
    command = sys.argv[sys.argv.index("--") + 1:]
    steps = json.load(open(steps_file))
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(command[0], command, os.environ)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(columns), 0, 0))
    recorded = bytearray()
    status = 0

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                recorded.extend(data)
        return True

    for step in steps:
        if "send" in step:
            try:
                os.write(fd, step["send"].encode())
            except OSError:
                break  # the program is gone already; the checks on its output say what went wrong
            pump(0.15)
        elif "sleep" in step:
            pump(step["sleep"])
        elif "expect" in step:
            pattern = re.compile(step["expect"])
            deadline = time.time() + step.get("timeout", 8)
            while not pattern.search(ANSI.sub("", recorded.decode("utf8", "replace"))):
                if time.time() > deadline:
                    status = 3
                    break
                if not pump(0.1):
                    break
            if status:
                break
    # let the program finish, then stop it if it did not
    deadline = time.time() + 5
    alive = True
    while time.time() < deadline:
        pump(0.1)
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done:
            alive = False
            break
    if alive:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        status = status or 4
    open(output_file, "wb").write(bytes(recorded))
    sys.exit(status)


main()
