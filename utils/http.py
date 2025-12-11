"""
Sakura HTTP Utilities - HTTP 客户端工具

提供同步和异步 HTTP 客户端实例
"""

from typing import Optional

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False


# 默认超时配置
DEFAULT_TIMEOUT = 60.0
DEFAULT_CONNECT_TIMEOUT = 10.0


def get_default_sync_client(
    timeout: Optional[float] = None,
    **kwargs,
) -> "httpx.Client":
    """
    获取默认的同步 HTTP 客户端
    
    Args:
        timeout: 请求超时时间（秒）
        **kwargs: 传递给 httpx.Client 的其他参数
    
    Returns:
        httpx.Client 实例
    """
    if not HAS_HTTPX:
        raise ImportError("httpx is required. Install with: pip install httpx")
    
    return httpx.Client(
        timeout=timeout or DEFAULT_TIMEOUT,
        **kwargs,
    )


def get_default_async_client(
    timeout: Optional[float] = None,
    **kwargs,
) -> "httpx.AsyncClient":
    """
    获取默认的异步 HTTP 客户端
    
    Args:
        timeout: 请求超时时间（秒）
        **kwargs: 传递给 httpx.AsyncClient 的其他参数
    
    Returns:
        httpx.AsyncClient 实例
    """
    if not HAS_HTTPX:
        raise ImportError("httpx is required. Install with: pip install httpx")
    
    return httpx.AsyncClient(
        timeout=timeout or DEFAULT_TIMEOUT,
        **kwargs,
    )
