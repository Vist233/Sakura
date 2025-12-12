"""
Glob 工具 - 文件模式搜索

官方设计：
- 支持 **/*.py 等 glob 模式
- 返回按修改时间排序的文件列表
- 用于查找文件，不用于内容搜索
"""

import glob as glob_module
from pathlib import Path
from typing import Optional, List
import os

from sakura.tools import tool


@tool
def glob(
    pattern: str,
    path: Optional[str] = None,
    limit: int = 100,
) -> str:
    """
    按模式搜索文件。
    
    Args:
        pattern: Glob 模式（如 "**/*.py", "src/**/*.ts"）
        path: 搜索根目录（默认当前目录）
        limit: 最大返回数量（默认 100）
    
    Returns:
        匹配的文件列表（按修改时间排序，最新在前）
    
    Examples:
        glob("**/*.py")  # 所有 Python 文件
        glob("src/**/*.ts", path="/project")  # 指定目录
        glob("*.md")  # 当前目录的 markdown 文件
    """
    search_path = Path(path) if path else Path.cwd()
    
    if not search_path.exists():
        return f"❌ Error: Path not found: {search_path}"
    
    if not search_path.is_dir():
        return f"❌ Error: Not a directory: {search_path}"
    
    # 执行 glob 搜索
    full_pattern = str(search_path / pattern)
    
    try:
        matches = list(glob_module.glob(full_pattern, recursive=True))
    except Exception as e:
        return f"❌ Error in glob pattern: {e}"
    
    # 过滤只保留文件
    files = [f for f in matches if os.path.isfile(f)]
    
    # 按修改时间排序（最新在前）
    files.sort(key=lambda x: os.path.getmtime(x), reverse=True)
    
    # 限制数量
    total = len(files)
    files = files[:limit]
    
    if not files:
        return f"No files found matching pattern: {pattern}"
    
    # 转为相对路径
    try:
        relative_files = [str(Path(f).relative_to(search_path)) for f in files]
    except ValueError:
        relative_files = files
    
    output_lines = [f"Found {total} files matching '{pattern}'"]
    if total > limit:
        output_lines.append(f"(showing first {limit})")
    output_lines.append("")
    output_lines.extend(relative_files)
    
    return "\n".join(output_lines)
