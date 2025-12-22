"""
API 测试专用配置

这些测试需要真实的 API Key 才能运行
在 CI/CD 中默认跳过，本地开发时可以运行
"""

import os
import pytest


# ============================================
# API Key 检查辅助函数
# ============================================

def has_dashscope_key() -> bool:
    """检查是否有 DashScope API Key"""
    return bool(os.getenv("DASHSCOPE_API_KEY"))


def has_openai_key() -> bool:
    """检查是否有 OpenAI API Key"""
    return bool(os.getenv("OPENAI_API_KEY"))


def has_anthropic_key() -> bool:
    """检查是否有 Anthropic API Key"""
    return bool(os.getenv("ANTHROPIC_API_KEY"))


def has_any_api_key() -> bool:
    """检查是否有任意 API Key"""
    return has_dashscope_key() or has_openai_key() or has_anthropic_key()


# ============================================
# Pytest 跳过装饰器
# ============================================

skip_if_no_dashscope = pytest.mark.skipif(
    not has_dashscope_key(),
    reason="DASHSCOPE_API_KEY not set"
)

skip_if_no_openai = pytest.mark.skipif(
    not has_openai_key(),
    reason="OPENAI_API_KEY not set"
)

skip_if_no_anthropic = pytest.mark.skipif(
    not has_anthropic_key(),
    reason="ANTHROPIC_API_KEY not set"
)

skip_if_no_api = pytest.mark.skipif(
    not has_any_api_key(),
    reason="No API key set"
)


# ============================================
# Fixtures
# ============================================

@pytest.fixture
def qwen_model():
    """创建真实的 Qwen 模型（需要 DASHSCOPE_API_KEY）"""
    if not has_dashscope_key():
        pytest.skip("DASHSCOPE_API_KEY not set")
    
    from sakura.models import Qwen
    return Qwen(id="qwen-plus")


@pytest.fixture
def openai_model():
    """创建真实的 OpenAI 模型（需要 OPENAI_API_KEY）"""
    if not has_openai_key():
        pytest.skip("OPENAI_API_KEY not set")
    
    from sakura.models import OpenAI
    return OpenAI(id="gpt-4o-mini")


@pytest.fixture
def claude_model():
    """创建真实的 Claude 模型（需要 ANTHROPIC_API_KEY）"""
    if not has_anthropic_key():
        pytest.skip("ANTHROPIC_API_KEY not set")
    
    from sakura.models import Claude
    return Claude(id="claude-sonnet-4-20250514")
