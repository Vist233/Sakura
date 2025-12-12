"""
TodoWrite 工具 - Claude Code 核心任务管理

官方设计：
- 3 种状态：pending, in_progress, completed
- content: 任务描述（祈使句）
- activeForm: 进行中显示（现在进行时）
- 每次调用都替换整个列表

关键规则：
- 一次只能有一个 in_progress 任务
- 完成任务后立即标记 completed
- 复杂任务分解成小步骤
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional, Literal
from enum import Enum

from sakura.tools import tool


# 全局任务列表
_todo_list: List[Dict] = []


def get_todos() -> List[Dict]:
    """获取当前任务列表"""
    return _todo_list.copy()


def clear_todos() -> None:
    """清空任务列表"""
    global _todo_list
    _todo_list = []


@tool
def todo(
    todos: List[Dict],
) -> str:
    """
    管理任务列表，跟踪工作进度。
    
    每次调用会替换整个任务列表。使用此工具来：
    - 规划复杂任务的步骤
    - 跟踪当前进度
    - 让用户看到工作状态
    
    Args:
        todos: 任务列表，每个任务包含：
               - content: 任务描述 (祈使句，如 "Fix the bug")
               - status: 状态 (pending/in_progress/completed)
               - activeForm: 进行中显示 (现在进行时，如 "Fixing the bug")
    
    Returns:
        格式化的任务列表状态
    
    Examples:
        todo([
            {"content": "Read the file", "status": "completed", "activeForm": "Reading the file"},
            {"content": "Fix the bug", "status": "in_progress", "activeForm": "Fixing the bug"},
            {"content": "Run tests", "status": "pending", "activeForm": "Running tests"}
        ])
    
    Rules:
        - 一次只能有一个 in_progress 任务
        - 完成后立即标记 completed，不要批量更新
        - 复杂任务分解成 3-5 个小步骤
    """
    global _todo_list
    
    # 验证输入
    if not isinstance(todos, list):
        return "❌ Error: todos must be a list"
    
    valid_statuses = {"pending", "in_progress", "completed"}
    in_progress_count = 0
    
    for i, todo_item in enumerate(todos):
        if not isinstance(todo_item, dict):
            return f"❌ Error: todo item {i} must be a dict"
        
        if "content" not in todo_item:
            return f"❌ Error: todo item {i} missing 'content'"
        
        if "status" not in todo_item:
            return f"❌ Error: todo item {i} missing 'status'"
        
        if todo_item["status"] not in valid_statuses:
            return f"❌ Error: invalid status '{todo_item['status']}' in item {i}"
        
        if todo_item["status"] == "in_progress":
            in_progress_count += 1
    
    # 警告：多个 in_progress
    warning = ""
    if in_progress_count > 1:
        warning = "\n⚠️ Warning: Multiple in_progress tasks. Best practice is one at a time."
    
    # 更新全局列表
    _todo_list = todos
    
    # 格式化输出
    output_lines = ["📋 **Task List**", ""]
    
    for todo_item in todos:
        status = todo_item["status"]
        content = todo_item.get("content", "")
        active_form = todo_item.get("activeForm", content)
        
        if status == "completed":
            icon = "✅"
            display = content
        elif status == "in_progress":
            icon = "🔄"
            display = active_form
        else:  # pending
            icon = "⬜"
            display = content
        
        output_lines.append(f"{icon} {display}")
    
    # 统计
    completed = sum(1 for t in todos if t["status"] == "completed")
    total = len(todos)
    
    output_lines.append("")
    output_lines.append(f"Progress: {completed}/{total} completed")
    
    return "\n".join(output_lines) + warning
