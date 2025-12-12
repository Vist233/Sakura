"""
Grep 工具 - 内容搜索

官方设计：
- 基于 ripgrep 的正则搜索
- 支持多种输出模式
- 支持文件类型过滤
"""

import subprocess
import shutil
from pathlib import Path
from typing import Optional, Literal

from sakura.tools import tool


def _has_ripgrep() -> bool:
    """检查是否安装了 ripgrep"""
    return shutil.which("rg") is not None


@tool
def grep(
    pattern: str,
    path: Optional[str] = None,
    glob: Optional[str] = None,
    output_mode: Literal["content", "files_with_matches", "count"] = "files_with_matches",
    case_insensitive: bool = False,
    context_lines: int = 0,
    limit: int = 50,
) -> str:
    """
    在文件中搜索内容。
    
    Args:
        pattern: 搜索模式（支持正则表达式）
        path: 搜索路径（默认当前目录）
        glob: 文件过滤（如 "*.py", "*.{ts,tsx}"）
        output_mode: 输出模式
            - "content": 显示匹配行
            - "files_with_matches": 只显示文件名（默认）
            - "count": 显示匹配数量
        case_insensitive: 忽略大小写（默认 False）
        context_lines: 显示上下文行数（仅 content 模式）
        limit: 最大结果数（默认 50）
    
    Returns:
        搜索结果
    
    Examples:
        grep("TODO")  # 搜索 TODO
        grep("def.*async", glob="*.py")  # Python 异步函数
        grep("error", output_mode="content", context_lines=2)
    """
    search_path = Path(path) if path else Path.cwd()
    
    if not search_path.exists():
        return f"❌ Error: Path not found: {search_path}"
    
    # 优先使用 ripgrep，否则用 Python grep
    if _has_ripgrep():
        return _grep_with_ripgrep(
            pattern, search_path, glob, output_mode, 
            case_insensitive, context_lines, limit
        )
    else:
        return _grep_with_python(
            pattern, search_path, glob, output_mode,
            case_insensitive, limit
        )


def _grep_with_ripgrep(
    pattern: str,
    search_path: Path,
    glob_pattern: Optional[str],
    output_mode: str,
    case_insensitive: bool,
    context_lines: int,
    limit: int,
) -> str:
    """使用 ripgrep 搜索"""
    cmd = ["rg"]
    
    # 输出模式
    if output_mode == "files_with_matches":
        cmd.append("-l")
    elif output_mode == "count":
        cmd.append("-c")
    else:  # content
        cmd.append("-n")  # 显示行号
        if context_lines > 0:
            cmd.extend(["-C", str(context_lines)])
    
    if case_insensitive:
        cmd.append("-i")
    
    if glob_pattern:
        cmd.extend(["--glob", glob_pattern])
    
    cmd.append(pattern)
    cmd.append(str(search_path))
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        
        output = result.stdout
        
        # 限制输出
        lines = output.strip().split("\n")
        if len(lines) > limit:
            lines = lines[:limit]
            lines.append(f"... ({len(lines)} more results)")
        
        if not lines or lines == [""]:
            return f"No matches found for pattern: {pattern}"
        
        return f"Found matches for '{pattern}':\n" + "\n".join(lines)
        
    except subprocess.TimeoutExpired:
        return "❌ Error: Search timed out"
    except Exception as e:
        return f"❌ Error: {e}"


def _grep_with_python(
    pattern: str,
    search_path: Path,
    glob_pattern: Optional[str],
    output_mode: str,
    case_insensitive: bool,
    limit: int,
) -> str:
    """使用 Python 正则搜索（fallback）"""
    import re
    import fnmatch
    
    flags = re.IGNORECASE if case_insensitive else 0
    
    try:
        regex = re.compile(pattern, flags)
    except re.error as e:
        return f"❌ Error: Invalid regex: {e}"
    
    results = []
    
    # 遍历文件
    for file_path in search_path.rglob("*"):
        if not file_path.is_file():
            continue
        
        # 过滤文件
        if glob_pattern and not fnmatch.fnmatch(file_path.name, glob_pattern):
            continue
        
        try:
            content = file_path.read_text(encoding='utf-8', errors='ignore')
        except Exception:
            continue
        
        matches = regex.findall(content)
        if matches:
            if output_mode == "files_with_matches":
                results.append(str(file_path.relative_to(search_path)))
            elif output_mode == "count":
                results.append(f"{file_path.relative_to(search_path)}: {len(matches)}")
            else:  # content
                for i, line in enumerate(content.split("\n"), 1):
                    if regex.search(line):
                        results.append(f"{file_path.relative_to(search_path)}:{i}: {line}")
        
        if len(results) >= limit:
            break
    
    if not results:
        return f"No matches found for pattern: {pattern}"
    
    return f"Found matches for '{pattern}':\n" + "\n".join(results[:limit])
