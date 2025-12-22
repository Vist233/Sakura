"""
Sakura Agent 执行流程追踪器

提供 @trace_flow 装饰器和 FlowTracer 类
用于追踪 Agent/SubAgent/Tool 的执行链路并生成流程图

使用方式:
    @trace_flow
    async def research(topic):
        agent = Agent(...)
        return await agent.arun(topic)
    
    # 带配置
    @trace_flow(output_file="trace.html")
    async def research(topic):
        ...
"""

import asyncio
import contextvars
import functools
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union
from contextlib import contextmanager


# ============================================================
# 数据模型
# ============================================================

@dataclass
class TraceSpan:
    """单个追踪 Span
    
    表示一个操作单元（Agent调用、工具执行、LLM调用等）
    """
    span_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    parent_id: Optional[str] = None
    name: str = ""
    span_type: str = "generic"  # agent | subagent | tool | llm | function
    start_time: float = field(default_factory=time.perf_counter)
    end_time: Optional[float] = None
    status: str = "running"  # running | success | error
    metadata: Dict[str, Any] = field(default_factory=dict)
    children: List["TraceSpan"] = field(default_factory=list)
    error: Optional[str] = None
    
    @property
    def duration(self) -> float:
        """获取执行时长（秒）"""
        if self.end_time:
            return self.end_time - self.start_time
        return time.perf_counter() - self.start_time
    
    def finish(self, status: str = "success", error: str = None):
        """完成 Span"""
        self.end_time = time.perf_counter()
        self.status = status
        if error:
            self.error = error
    
    def add_metadata(self, **kwargs):
        """添加元数据"""
        self.metadata.update(kwargs)


# ============================================================
# FlowTracer 核心类
# ============================================================

# 使用 contextvars 实现协程安全的当前 tracer
_current_tracer: contextvars.ContextVar[Optional["FlowTracer"]] = contextvars.ContextVar(
    "current_tracer", default=None
)


class FlowTracer:
    """执行流程追踪器
    
    追踪 Agent/SubAgent/Tool 的执行链路
    
    Usage:
        # 作为上下文管理器
        with FlowTracer() as tracer:
            result = await agent.arun(topic)
            print(tracer.to_mermaid())
        
        # 获取当前 tracer
        tracer = FlowTracer.get_current()
        if tracer:
            tracer.add_span("tool_call", span_type="tool")
    """
    
    def __init__(self, name: str = "trace"):
        self.name = name
        self.root_span: Optional[TraceSpan] = None
        self._span_stack: List[TraceSpan] = []
        self._token: Optional[contextvars.Token] = None
        self._start_time = time.perf_counter()
    
    @classmethod
    def get_current(cls) -> Optional["FlowTracer"]:
        """获取当前上下文中的 tracer"""
        return _current_tracer.get()
    
    def __enter__(self) -> "FlowTracer":
        self._token = _current_tracer.set(self)
        self.root_span = TraceSpan(
            name=self.name,
            span_type="trace",
        )
        self._span_stack.append(self.root_span)
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.root_span:
            self.root_span.finish(
                status="error" if exc_type else "success",
                error=str(exc_val) if exc_val else None
            )
        if self._token:
            _current_tracer.reset(self._token)
        return False
    
    async def __aenter__(self) -> "FlowTracer":
        return self.__enter__()
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return self.__exit__(exc_type, exc_val, exc_tb)
    
    @contextmanager
    def span(
        self,
        name: str,
        span_type: str = "generic",
        **metadata
    ):
        """创建一个子 Span 上下文
        
        Usage:
            with tracer.span("Agent:main", span_type="agent"):
                # 执行操作
                ...
        """
        parent = self._span_stack[-1] if self._span_stack else None
        
        new_span = TraceSpan(
            name=name,
            span_type=span_type,
            parent_id=parent.span_id if parent else None,
            metadata=metadata,
        )
        
        if parent:
            parent.children.append(new_span)
        
        self._span_stack.append(new_span)
        
        try:
            yield new_span
            new_span.finish(status="success")
        except Exception as e:
            new_span.finish(status="error", error=str(e))
            raise
        finally:
            self._span_stack.pop()
    
    def add_event(self, name: str, span_type: str = "event", **metadata) -> TraceSpan:
        """添加一个事件 Span（无子节点）"""
        parent = self._span_stack[-1] if self._span_stack else self.root_span
        
        event_span = TraceSpan(
            name=name,
            span_type=span_type,
            parent_id=parent.span_id if parent else None,
            metadata=metadata,
        )
        event_span.finish(status="success")
        
        if parent:
            parent.children.append(event_span)
        
        return event_span
    
    # ============================================================
    # 可视化输出
    # ============================================================
    
    def to_mermaid(self) -> str:
        """生成 Mermaid 流程图代码"""
        if not self.root_span:
            return "```mermaid\nflowchart TB\n    A[No trace data]\n```"
        
        return _generate_mermaid(self.root_span)
    
    def to_html(self, title: str = "Agent Execution Flow") -> str:
        """生成独立 HTML 页面（包含 Mermaid 渲染）"""
        mermaid_code = self.to_mermaid()
        # 移除 markdown 代码块标记
        mermaid_content = mermaid_code.replace("```mermaid\n", "").replace("\n```", "")
        
        return _generate_html(mermaid_content, title)
    
    def print_trace(self):
        """打印 Mermaid 代码到终端"""
        print("\n" + "=" * 60)
        print("📊 执行流程图 (Mermaid)")
        print("=" * 60)
        print(self.to_mermaid())
        print("=" * 60 + "\n")
    
    def save(self, filepath: str):
        """保存到文件
        
        Args:
            filepath: 文件路径，根据后缀自动选择格式
                     .html -> HTML 格式
                     .md -> Mermaid Markdown 格式
        """
        if filepath.endswith(".html"):
            content = self.to_html()
        else:
            content = self.to_mermaid()
        
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        
        print(f"📁 流程图已保存到: {filepath}")


# ============================================================
# Mermaid 生成器
# ============================================================

def _generate_mermaid(root: TraceSpan) -> str:
    """生成 Mermaid 流程图"""
    lines = ["```mermaid", "flowchart TB"]
    node_counter = [0]  # 使用列表以便在嵌套函数中修改
    
    def get_node_id():
        node_counter[0] += 1
        return f"n{node_counter[0]}"
    
    def get_node_style(span: TraceSpan) -> str:
        """根据 span 类型返回不同的节点样式"""
        duration = f"{span.duration:.2f}s" if span.end_time else "running"
        tokens = span.metadata.get("tokens", "")
        token_info = f" | {tokens} tokens" if tokens else ""
        
        label = f"{span.name}<br/>{duration}{token_info}"
        
        if span.span_type == "tool":
            return f'["{label}"]'  # 方形
        elif span.span_type in ("agent", "subagent"):
            return f'("{label}")'  # 圆角
        elif span.span_type == "llm":
            return f'[/"{label}"/]'  # 平行四边形
        elif span.span_type == "trace":
            return f'[["{label}"]]'  # 双边框
        else:
            return f'("{label}")'
    
    def get_status_style(span: TraceSpan) -> Optional[str]:
        """返回状态相关的样式"""
        if span.status == "error":
            return "fill:#ffcdd2"  # 红色
        elif span.span_type == "tool":
            return "fill:#e3f2fd"  # 蓝色
        elif span.span_type in ("agent", "subagent"):
            return "fill:#e8f5e9"  # 绿色
        return None
    
    def render_span(span: TraceSpan, parent_node_id: Optional[str] = None) -> str:
        node_id = get_node_id()
        node_style = get_node_style(span)
        
        lines.append(f"    {node_id}{node_style}")
        
        if parent_node_id:
            lines.append(f"    {parent_node_id} --> {node_id}")
        
        # 添加状态样式
        status_style = get_status_style(span)
        if status_style:
            lines.append(f"    style {node_id} {status_style}")
        
        # 处理子节点
        if len(span.children) > 1:
            # 多个子节点 - 可能是并行执行
            # 检查是否真的是并行（时间重叠）
            is_parallel = _check_parallel(span.children)
            
            if is_parallel:
                subgraph_id = f"parallel_{node_id}"
                lines.append(f'    subgraph {subgraph_id}["🔀 并行执行"]')
                for child in span.children:
                    render_span(child, node_id)
                lines.append("    end")
                lines.append(f"    style {subgraph_id} fill:#fff3e0")
            else:
                # 顺序执行
                prev_id = node_id
                for child in span.children:
                    child_id = render_span(child, prev_id)
                    prev_id = child_id
        else:
            for child in span.children:
                render_span(child, node_id)
        
        return node_id
    
    render_span(root)
    lines.append("```")
    
    return "\n".join(lines)


def _check_parallel(spans: List[TraceSpan]) -> bool:
    """检查多个 span 是否并行执行（时间有重叠）"""
    if len(spans) < 2:
        return False
    
    # 简单检查：如果第二个 span 在第一个结束前开始，则认为是并行
    for i in range(len(spans) - 1):
        span1 = spans[i]
        span2 = spans[i + 1]
        
        # 如果 span2 开始时 span1 还在运行，则是并行
        if span1.end_time is None or span2.start_time < span1.end_time:
            return True
    
    return False


# ============================================================
# HTML 生成器
# ============================================================

def _generate_html(mermaid_content: str, title: str) -> str:
    """生成包含 Mermaid 图的 HTML 页面"""
    return f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }}
        h1 {{
            color: #333;
            border-bottom: 2px solid #e91e63;
            padding-bottom: 10px;
        }}
        .mermaid {{
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }}
        .info {{
            background: white;
            padding: 15px;
            border-radius: 8px;
            margin-top: 20px;
            font-size: 14px;
            color: #666;
        }}
    </style>
</head>
<body>
    <h1>📊 {title}</h1>
    <div class="mermaid">
{mermaid_content}
    </div>
    <div class="info">
        <p>生成时间: {time.strftime("%Y-%m-%d %H:%M:%S")}</p>
        <p>由 <strong>Sakura Agent Framework</strong> 生成</p>
    </div>
    <script>
        mermaid.initialize({{ startOnLoad: true, theme: 'default' }});
    </script>
</body>
</html>'''


# ============================================================
# 装饰器
# ============================================================

def trace_flow(
    func: Callable = None,
    *,
    output_file: str = None,
    print_trace: bool = True,
    name: str = None,
):
    """追踪函数执行流程并生成可视化流程图
    
    装饰器会自动创建 FlowTracer 上下文，函数内部可以通过
    FlowTracer.get_current() 获取当前 tracer 并添加 span。
    
    Args:
        func: 被装饰的函数
        output_file: 输出文件路径（可选）
                    .html -> HTML 格式
                    .md -> Mermaid Markdown 格式
        print_trace: 是否在终端打印 Mermaid 代码（默认 True）
        name: 追踪名称（默认使用函数名）
    
    Usage:
        @trace_flow
        async def research(topic):
            agent = Agent(...)
            return await agent.arun(topic)
        
        @trace_flow(output_file="trace.html", print_trace=False)
        async def research(topic):
            ...
    """
    def decorator(f: Callable) -> Callable:
        trace_name = name or f.__name__
        
        @functools.wraps(f)
        def sync_wrapper(*args, **kwargs):
            with FlowTracer(name=trace_name) as tracer:
                try:
                    result = f(*args, **kwargs)
                    return result
                finally:
                    if print_trace:
                        tracer.print_trace()
                    if output_file:
                        tracer.save(output_file)
        
        @functools.wraps(f)
        async def async_wrapper(*args, **kwargs):
            async with FlowTracer(name=trace_name) as tracer:
                try:
                    result = await f(*args, **kwargs)
                    return result
                finally:
                    if print_trace:
                        tracer.print_trace()
                    if output_file:
                        tracer.save(output_file)
        
        if asyncio.iscoroutinefunction(f):
            return async_wrapper
        return sync_wrapper
    
    if func is not None:
        return decorator(func)
    return decorator


# ============================================================
# 便捷函数
# ============================================================

def trace_span(name: str, span_type: str = "generic", **metadata):
    """在当前 tracer 中创建一个 span 上下文
    
    这是一个便捷函数，避免每次都获取 tracer
    
    Usage:
        with trace_span("tool_call", span_type="tool", tool_name="search"):
            result = search(query)
    """
    tracer = FlowTracer.get_current()
    if tracer:
        return tracer.span(name, span_type=span_type, **metadata)
    else:
        # 如果没有 tracer，返回一个空的上下文管理器
        @contextmanager
        def noop():
            yield None
        return noop()


def trace_event(name: str, span_type: str = "event", **metadata):
    """在当前 tracer 中添加一个事件
    
    Usage:
        trace_event("LLM 调用", span_type="llm", tokens=1024)
    """
    tracer = FlowTracer.get_current()
    if tracer:
        return tracer.add_event(name, span_type=span_type, **metadata)
    return None
