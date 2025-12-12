"""
Sakura Parallel Execution - 并行执行工具

提供并行工具执行的核心功能和指标追踪
"""

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from ..tools.function import Function, FunctionCall
    from ..messages.message import Message


@dataclass
class ParallelExecutionMetrics:
    """
    并行执行指标追踪
    
    记录并行执行的统计信息用于性能分析
    
    Example:
        metrics = ParallelExecutionMetrics()
        metrics.record_execution("search", 0.5, parallel=True)
        print(metrics.report())
    """
    
    total_calls: int = 0
    parallel_calls: int = 0
    sequential_calls: int = 0
    total_latency: float = 0
    parallel_latency: float = 0
    errors: int = 0
    timeouts: int = 0
    
    tool_latencies: Dict[str, List[float]] = field(default_factory=dict)
    
    def record_execution(
        self,
        tool_name: str,
        latency: float,
        parallel: bool = False,
        error: bool = False,
        timeout: bool = False
    ):
        """记录一次工具执行"""
        self.total_calls += 1
        self.total_latency += latency
        
        if parallel:
            self.parallel_calls += 1
            self.parallel_latency += latency
        else:
            self.sequential_calls += 1
        
        if error:
            self.errors += 1
        
        if timeout:
            self.timeouts += 1
        
        if tool_name not in self.tool_latencies:
            self.tool_latencies[tool_name] = []
        self.tool_latencies[tool_name].append(latency)
    
    @property
    def parallel_ratio(self) -> float:
        """并行执行比例"""
        if self.total_calls == 0:
            return 0
        return self.parallel_calls / self.total_calls
    
    @property
    def avg_latency(self) -> float:
        """平均延迟"""
        if self.total_calls == 0:
            return 0
        return self.total_latency / self.total_calls
    
    @property
    def estimated_savings(self) -> float:
        """预估节省的时间（假设顺序执行需要的总时间 - 实际并行时间）"""
        # 这是一个粗略估计
        if self.parallel_calls <= 1:
            return 0
        # 假设并行调用中最长的就是实际花费时间
        return self.parallel_latency - (self.parallel_latency / self.parallel_calls)
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "total_calls": self.total_calls,
            "parallel_calls": self.parallel_calls,
            "sequential_calls": self.sequential_calls,
            "parallel_ratio": round(self.parallel_ratio * 100, 1),
            "errors": self.errors,
            "timeouts": self.timeouts,
            "avg_latency_s": round(self.avg_latency, 3),
            "estimated_savings_s": round(self.estimated_savings, 3),
        }
    
    def report(self) -> str:
        """生成报告"""
        tool_report = self._tool_latency_report()
        return f"""并行执行统计:
- 总调用: {self.total_calls}
- 并行调用: {self.parallel_calls} ({self.parallel_ratio*100:.1f}%)
- 顺序调用: {self.sequential_calls}
- 错误数: {self.errors}
- 超时数: {self.timeouts}
- 平均延迟: {self.avg_latency:.3f}s
- 预估节省: {self.estimated_savings:.2f}s

工具延迟分布:
{tool_report}"""
    
    def _tool_latency_report(self) -> str:
        """工具延迟报告"""
        if not self.tool_latencies:
            return "  (无数据)"
        
        lines = []
        for name, latencies in sorted(self.tool_latencies.items()):
            avg = sum(latencies) / len(latencies)
            max_lat = max(latencies)
            lines.append(f"  - {name}: avg {avg:.2f}s, max {max_lat:.2f}s ({len(latencies)} 次)")
        return "\n".join(lines)
    
    def reset(self):
        """重置所有指标"""
        self.total_calls = 0
        self.parallel_calls = 0
        self.sequential_calls = 0
        self.total_latency = 0
        self.parallel_latency = 0
        self.errors = 0
        self.timeouts = 0
        self.tool_latencies.clear()


async def execute_tools_parallel(
    tool_calls: List["FunctionCall"],
    timeout: float = 30.0,
    max_concurrent: int = 5,
    metrics: Optional[ParallelExecutionMetrics] = None
) -> List[Tuple[str, Any, bool]]:
    """
    并行执行多个工具调用
    
    Args:
        tool_calls: 工具调用列表
        timeout: 单个工具超时时间
        max_concurrent: 最大并发数
        metrics: 指标追踪器
    
    Returns:
        List of (tool_call_id, result, success)
    """
    import time
    
    semaphore = asyncio.Semaphore(max_concurrent)
    
    async def execute_one(fc: "FunctionCall") -> Tuple[str, Any, bool]:
        """执行单个工具"""
        start_time = time.perf_counter()
        error = False
        timed_out = False
        
        async with semaphore:
            try:
                # 检查工具是否有异步入口
                if hasattr(fc.function, 'async_entrypoint') and fc.function.async_entrypoint:
                    result = await asyncio.wait_for(
                        fc.function.async_entrypoint(**fc.arguments),
                        timeout=timeout
                    )
                elif hasattr(fc, 'aexecute'):
                    result = await asyncio.wait_for(
                        fc.aexecute(),
                        timeout=timeout
                    )
                else:
                    # 同步函数在线程池中执行
                    loop = asyncio.get_event_loop()
                    result = await asyncio.wait_for(
                        loop.run_in_executor(None, fc.execute),
                        timeout=timeout
                    )
                
                # 提取结果内容
                if hasattr(result, 'result'):
                    content = result.result
                else:
                    content = result
                
                return (fc.call_id, content, True)
                
            except asyncio.TimeoutError:
                timed_out = True
                error = True
                return (fc.call_id, f"Timeout after {timeout}s", False)
            except Exception as e:
                error = True
                return (fc.call_id, f"Error: {str(e)}", False)
            finally:
                elapsed = time.perf_counter() - start_time
                if metrics:
                    metrics.record_execution(
                        tool_name=fc.function.name,
                        latency=elapsed,
                        parallel=True,
                        error=error,
                        timeout=timed_out
                    )
    
    # 并行执行所有工具
    results = await asyncio.gather(
        *[execute_one(fc) for fc in tool_calls],
        return_exceptions=True
    )
    
    # 处理 gather 返回的异常
    processed = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            processed.append((tool_calls[i].call_id, f"Error: {str(result)}", False))
        else:
            processed.append(result)
    
    return processed


def separate_parallel_tools(
    tool_calls: List["FunctionCall"]
) -> Tuple[List["FunctionCall"], List["FunctionCall"]]:
    """
    分离可并行和需要顺序执行的工具
    
    Returns:
        (parallel_safe_calls, sequential_calls)
    """
    parallel = []
    sequential = []
    
    for fc in tool_calls:
        # 检查工具是否标记为并行安全
        parallel_safe = getattr(fc.function, 'parallel_safe', True)
        requires_confirmation = getattr(fc.function, 'requires_confirmation', False)
        external_execution = getattr(fc.function, 'external_execution', False)
        
        if not parallel_safe or requires_confirmation or external_execution:
            sequential.append(fc)
        else:
            parallel.append(fc)
    
    return parallel, sequential
