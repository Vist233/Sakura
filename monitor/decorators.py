"""
监控装饰器

提供 @timer 和 @monitor 装饰器
"""

import asyncio
import functools
from time import perf_counter
from typing import Callable, Optional, Any


def timer(func: Callable = None, *, name: str = None, verbose: bool = True):
    """
    计时装饰器 - 统计函数执行时间
    
    支持同步和异步函数
    
    Usage:
        @timer
        def my_function():
            ...
        
        @timer(name="API调用", verbose=False)
        async def api_call():
            ...
    
    Args:
        func: 被装饰的函数
        name: 显示名称，默认使用函数名
        verbose: 是否打印耗时信息
    """
    def decorator(f: Callable) -> Callable:
        display_name = name or f.__name__
        
        @functools.wraps(f)
        def sync_wrapper(*args, **kwargs):
            start = perf_counter()
            try:
                result = f(*args, **kwargs)
                return result
            finally:
                elapsed = perf_counter() - start
                if verbose:
                    print(f"⏱ {display_name}: {elapsed:.2f}s")
        
        @functools.wraps(f)
        async def async_wrapper(*args, **kwargs):
            start = perf_counter()
            try:
                result = await f(*args, **kwargs)
                return result
            finally:
                elapsed = perf_counter() - start
                if verbose:
                    print(f"⏱ {display_name}: {elapsed:.2f}s")
        
        if asyncio.iscoroutinefunction(f):
            return async_wrapper
        return sync_wrapper
    
    # 支持 @timer 和 @timer() 两种用法
    if func is not None:
        return decorator(func)
    return decorator


def monitor(
    func: Callable = None,
    *,
    storage: Any = None,
    log_input: bool = True,
    log_output: bool = True,
):
    """
    监控装饰器 - 记录函数调用到存储后端
    
    Usage:
        from agentWorkframe.monitor import monitor, SQLiteStorage
        
        storage = SQLiteStorage("./logs.db")
        
        @monitor(storage=storage)
        def agent_run(prompt: str):
            ...
    
    Args:
        func: 被装饰的函数
        storage: 存储后端实例
        log_input: 是否记录输入
        log_output: 是否记录输出
    """
    def decorator(f: Callable) -> Callable:
        @functools.wraps(f)
        def sync_wrapper(*args, **kwargs):
            start = perf_counter()
            error = None
            result = None
            
            try:
                result = f(*args, **kwargs)
                return result
            except Exception as e:
                error = str(e)
                raise
            finally:
                elapsed = perf_counter() - start
                if storage is not None:
                    storage.log(
                        function_name=f.__name__,
                        input_args=args if log_input else None,
                        input_kwargs=kwargs if log_input else None,
                        output=result if log_output else None,
                        error=error,
                        exec_time=elapsed,
                    )
        
        @functools.wraps(f)
        async def async_wrapper(*args, **kwargs):
            start = perf_counter()
            error = None
            result = None
            
            try:
                result = await f(*args, **kwargs)
                return result
            except Exception as e:
                error = str(e)
                raise
            finally:
                elapsed = perf_counter() - start
                if storage is not None:
                    storage.log(
                        function_name=f.__name__,
                        input_args=args if log_input else None,
                        input_kwargs=kwargs if log_input else None,
                        output=result if log_output else None,
                        error=error,
                        exec_time=elapsed,
                    )
        
        if asyncio.iscoroutinefunction(f):
            return async_wrapper
        return sync_wrapper
    
    if func is not None:
        return decorator(func)
    return decorator
