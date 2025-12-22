#!/usr/bin/env python3
"""
Sakura Claude Code 模式 - 使用示例

演示如何使用 Claude Code 风格的工具集
"""

import os
from pathlib import Path

# 设置环境变量（如果需要）
# os.environ["OPENAI_API_KEY"] = "your-key"
# os.environ["DASHSCOPE_API_KEY"] = "your-key"  # 如果用阿里云

from sakura.claude_code import ClaudeCodeAgent
from sakura.claude_code.tools import read, write, edit, todo, bash, glob, grep


def example_basic():
    """基础示例：创建 Agent 并运行简单任务"""
    
    # 创建 ClaudeCodeAgent
    # 使用 qwen-plus 或其他模型
    agent = ClaudeCodeAgent(
        model="qwen-plus",  # 或 "gpt-4", "claude-3-sonnet" 等
        tools=[read, write, edit, todo, bash, glob, grep],
        # system_prompt 已内置 Claude Code 风格
    )
    
    # 运行简单任务
    result = agent.run("帮我列出当前目录的 Python 文件")
    print(result.content)


def example_file_operations():
    """文件操作示例：演示强制读后写机制"""
    
    agent = ClaudeCodeAgent(
        model="qwen-plus",
        tools=[read, write, edit],
    )
    
    # 让 Agent 读取并修改文件
    # Agent 会自动：
    # 1. 先 read() 读取文件
    # 2. 再用 edit() 或 write() 修改
    result = agent.run("""
    请帮我在 /tmp/test_sakura.py 创建一个简单的 Python 脚本：
    - 包含一个 hello() 函数
    - 打印 "Hello from Sakura!"
    """)
    print(result.content)


def example_complex_task():
    """复杂任务示例：使用 todo 管理任务"""
    
    agent = ClaudeCodeAgent(
        model="qwen-plus",
        tools=[read, write, edit, todo, glob, grep],
    )
    
    # 复杂任务会自动使用 todo 工具追踪进度
    result = agent.run("""
    帮我分析 sakura/claude_code 目录的代码结构：
    1. 列出所有 Python 文件
    2. 统计每个文件的函数数量
    3. 生成一个简单的报告
    """)
    print(result.content)


def example_search():
    """搜索示例：使用 glob 和 grep"""
    
    agent = ClaudeCodeAgent(
        model="qwen-plus",
        tools=[read, glob, grep],
    )
    
    result = agent.run("""
    在当前项目中搜索所有包含 "def " 的 Python 文件，
    然后告诉我哪个文件的函数最多。
    """)
    print(result.content)


# 直接调用工具（不通过 Agent）
def example_direct_tools():
    """直接调用工具示例"""
    
    from sakura.claude_code.tools.glob import glob as glob_tool
    from sakura.claude_code.tools.grep import grep as grep_tool
    from sakura.claude_code.tools.todo import todo as todo_tool
    from sakura.claude_code.file_state import FileStateTracker
    from sakura.claude_code.tools.read import set_file_state
    
    # 设置 FileState（如果需要使用 read/write/edit）
    tracker = FileStateTracker()
    set_file_state(tracker)
    
    # 直接调用工具的 entrypoint
    print("=== Glob 搜索 ===")
    result = glob_tool.entrypoint("*.py", limit=5)
    print(result)
    
    print("\n=== Todo 任务 ===")
    result = todo_tool.entrypoint([
        {"content": "Step 1", "status": "completed", "activeForm": "Completing step 1"},
        {"content": "Step 2", "status": "in_progress", "activeForm": "Working on step 2"},
        {"content": "Step 3", "status": "pending", "activeForm": "Preparing step 3"},
    ])
    print(result)


if __name__ == "__main__":
    print("Sakura Claude Code 模式示例\n")
    print("=" * 50)
    
    # 运行直接工具调用示例（不需要 API key）
    # example_direct_tools()
    
    # 如果设置了 API key，可以运行以下示例：
    example_basic()
    example_file_operations()
    example_complex_task()
    example_search()
