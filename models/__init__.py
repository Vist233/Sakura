"""Models module exports"""

from .base import Model
from .openai import OpenAIChat as OpenAI
from .openai_like import OpenAILike
from .qwen import DashScope as Qwen
from .openrouter import OpenRouter
from .kimi import Kimi

# Claude is optional - requires anthropic package
try:
    from .claude import Claude
except ImportError:
    Claude = None  # type: ignore

__all__ = [
    "Model",
    "OpenAI",
    "OpenAILike",
    "Qwen",
    "Claude",
    "OpenRouter",
    "Kimi",
]
