"""
Bash 工具 - 命令执行（带安全限制）

官方设计要点：
- 用于 git, npm, docker 等系统命令
- 不用于文件操作（用专门工具）
- 支持超时和后台运行
- 避免 cd 命令，使用绝对路径
"""

import subprocess
import shlex
from typing import Optional
from pathlib import Path

from sakura.tools import tool


# 禁止的命令模式
FORBIDDEN_PATTERNS = [
    "rm -rf /",
    "rm -rf ~",
    "mkfs",
    "> /dev/sda",
    "dd if=/dev/zero",
]

# 建议使用专门工具的命令
FILE_OPERATION_COMMANDS = ["cat", "head", "tail", "sed", "awk", "find", "grep", "echo >"]


@tool
def bash(
    command: str,
    timeout: int = 120000,
    description: Optional[str] = None,
    cwd: Optional[str] = None,
) -> str:
    """
    执行 bash 命令。
    
    用于系统操作如 git, npm, docker 等。
    不要用于文件操作（使用 read/write/edit 工具）。
    
    Args:
        command: 要执行的命令
        timeout: 超时时间（毫秒，默认 120000 = 2分钟，最大 600000 = 10分钟）
        description: 命令描述（5-10 词，如 "List files in directory"）
        cwd: 工作目录（可选，默认当前目录）
    
    Returns:
        命令输出或错误信息
    
    Examples:
        bash("git status")
        bash("npm install", timeout=300000)
        bash("ls -la /path/to/dir")
    
    Best Practices:
        - 使用绝对路径，避免 cd
        - 用 && 连接依赖命令
        - 引号包裹含空格的路径
    """
    # 安全检查
    for pattern in FORBIDDEN_PATTERNS:
        if pattern in command:
            return f"❌ Error: Dangerous command pattern detected: {pattern}"
    
    # 警告：建议用专门工具
    warning = ""
    for file_cmd in FILE_OPERATION_COMMANDS:
        if command.strip().startswith(file_cmd):
            warning = f"\n⚠️ Tip: Consider using dedicated tools (read/write/edit) instead of {file_cmd}"
            break
    
    # 限制超时
    timeout_seconds = min(timeout / 1000, 600)  # 最大10分钟
    
    # 确定工作目录
    working_dir = cwd if cwd else str(Path.cwd())
    
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=working_dir,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        
        output_parts = []
        
        if result.stdout:
            stdout = result.stdout
            if len(stdout) > 30000:
                stdout = stdout[:30000] + "\n... (output truncated)"
            output_parts.append(stdout)
        
        if result.stderr:
            stderr = result.stderr
            if len(stderr) > 10000:
                stderr = stderr[:10000] + "\n... (stderr truncated)"
            output_parts.append(f"stderr:\n{stderr}")
        
        if result.returncode != 0:
            output_parts.insert(0, f"❌ Exit code: {result.returncode}")
        else:
            output_parts.insert(0, f"✅ Command completed")
        
        return "\n".join(output_parts) + warning
        
    except subprocess.TimeoutExpired:
        return f"❌ Error: Command timed out after {timeout_seconds}s"
    except Exception as e:
        return f"❌ Error executing command: {e}"
