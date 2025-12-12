# Human-in-the-Loop (HITL) 最佳实践报告

> 基于 LangGraph、Permit.io、Anthropic 指南的深度分析

---

## 1. 核心概念

### 什么是 HITL

Human-in-the-Loop (HITL) 是一种架构模式，在 AI Agent 工作流的关键节点引入人工审核和干预，确保：

| 目标 | 说明 |
|------|------|
| **安全性** | 防止 Agent 执行危险操作 |
| **可靠性** | 人工验证关键决策 |
| **合规性** | 满足审计和监管要求 |
| **信任度** | 用户对 Agent 行为可控 |

### 典型场景

```
Agent: "我将删除 /data/production 目录"
       ⬇️
    [等待确认]
       ⬇️
Human: ✅ 批准 / ❌ 拒绝 / ✏️ 修改
       ⬇️
Agent: 执行或取消
```

---

## 2. 行业实现模式

### 2.1 Interrupt & Resume（LangGraph）

```python
from langgraph.graph import StateGraph
from langgraph.prebuilt import interrupt

def sensitive_tool_node(state):
    tool_call = state["tool_call"]
    
    # 检查是否需要确认
    if tool_call.name in SENSITIVE_TOOLS:
        # 暂停执行，等待人工输入
        human_input = interrupt(
            {
                "type": "tool_confirmation",
                "tool": tool_call.name,
                "args": tool_call.args,
                "message": f"确认执行 {tool_call.name}?"
            }
        )
        
        if human_input.get("approved"):
            return execute_tool(tool_call)
        else:
            return {"result": "Tool execution cancelled by user"}
    
    return execute_tool(tool_call)
```

**特点**：
- 原生支持暂停/恢复
- 状态自动持久化
- 支持超时处理

### 2.2 Human-as-a-Tool

```python
@tool
def ask_human(question: str) -> str:
    """当需要人工判断时调用此工具"""
    # 实际实现中会触发通知机制
    print(f"[HUMAN REQUIRED] {question}")
    response = wait_for_human_response()
    return response

# Agent 使用
agent = Agent(
    tools=[ask_human, search, write_file, ...],
    system_prompt="当你不确定时，使用 ask_human 工具询问用户"
)
```

**特点**：
- Agent 自主决定何时询问
- 对话式交互
- 灵活性高

### 2.3 Approval Flow（Permit.io 风格）

```python
from dataclasses import dataclass
from typing import Literal

@dataclass
class ApprovalRequest:
    action: str
    resource: str
    context: dict
    required_roles: list[str] = field(default_factory=lambda: ["admin"])

class ApprovalManager:
    """基于角色的审批管理"""
    
    def __init__(self):
        self._pending: dict[str, ApprovalRequest] = {}
    
    def request_approval(self, req: ApprovalRequest) -> str:
        """创建审批请求，返回请求 ID"""
        req_id = generate_id()
        self._pending[req_id] = req
        notify_approvers(req)
        return req_id
    
    def check_approval(self, req_id: str) -> Optional[bool]:
        """检查审批状态"""
        # 从持久化存储检查状态
        pass
    
    def wait_for_approval(self, req_id: str, timeout: float = 300) -> bool:
        """阻塞等待审批结果"""
        start = time.time()
        while time.time() - start < timeout:
            result = self.check_approval(req_id)
            if result is not None:
                return result
            time.sleep(1)
        raise TimeoutError("Approval timed out")
```

**特点**：
- 基于角色权限
- 异步审批
- 审计追踪

---

## 3. Sakura 推荐实现

### 3.1 设计原则

1. **声明式标记**：通过工具属性标记需要确认的操作
2. **可配置策略**：支持自定义确认条件
3. **非阻塞可选**：同步等待或异步回调
4. **与现有工具系统兼容**

### 3.2 工具级别确认

```python
# 方式 1：装饰器标记
@tool(requires_confirmation=True)
def delete_file(path: str) -> str:
    """删除文件"""
    os.remove(path)
    return f"Deleted {path}"

# 方式 2：条件确认
@tool(
    requires_confirmation=lambda args: args.get("path", "").startswith("/prod")
)
def write_file(path: str, content: str) -> str:
    """写入文件"""
    pass
```

### 3.3 确认处理器

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Optional, Any
from enum import Enum

class ConfirmationResult(str, Enum):
    APPROVED = "approved"
    REJECTED = "rejected"
    MODIFIED = "modified"
    TIMEOUT = "timeout"

@dataclass
class ConfirmationRequest:
    tool_name: str
    arguments: dict
    context: str = ""
    timeout: float = 300.0
    
    def to_prompt(self) -> str:
        return f"""
确认执行以下操作？

工具: {self.tool_name}
参数: {json.dumps(self.arguments, indent=2, ensure_ascii=False)}

{f"上下文: {self.context}" if self.context else ""}

[y] 确认  [n] 拒绝  [e] 编辑参数
"""


class ConfirmationHandler(ABC):
    """确认处理器基类"""
    
    @abstractmethod
    def request_confirmation(
        self, 
        request: ConfirmationRequest
    ) -> tuple[ConfirmationResult, dict]:
        """请求确认，返回 (结果, 修改后的参数)"""
        pass


class ConsoleConfirmationHandler(ConfirmationHandler):
    """命令行确认处理器"""
    
    def request_confirmation(
        self, 
        request: ConfirmationRequest
    ) -> tuple[ConfirmationResult, dict]:
        print(request.to_prompt())
        
        choice = input("选择: ").strip().lower()
        
        if choice == 'y':
            return ConfirmationResult.APPROVED, request.arguments
        elif choice == 'n':
            return ConfirmationResult.REJECTED, {}
        elif choice == 'e':
            # 简化：重新输入 JSON
            new_args_str = input("输入新参数 (JSON): ")
            new_args = json.loads(new_args_str)
            return ConfirmationResult.MODIFIED, new_args
        else:
            return ConfirmationResult.REJECTED, {}


class CallbackConfirmationHandler(ConfirmationHandler):
    """回调式确认处理器（用于 Web/API 场景）"""
    
    def __init__(self, callback: Callable[[ConfirmationRequest], Any]):
        self.callback = callback
        self._pending: dict[str, asyncio.Event] = {}
        self._results: dict[str, tuple] = {}
    
    async def request_confirmation(
        self, 
        request: ConfirmationRequest
    ) -> tuple[ConfirmationResult, dict]:
        req_id = str(uuid.uuid4())
        event = asyncio.Event()
        self._pending[req_id] = event
        
        # 触发外部通知
        self.callback({
            "id": req_id,
            "request": request.__dict__
        })
        
        # 等待结果
        try:
            await asyncio.wait_for(event.wait(), timeout=request.timeout)
            return self._results.pop(req_id)
        except asyncio.TimeoutError:
            return ConfirmationResult.TIMEOUT, {}
    
    def submit_result(
        self, 
        req_id: str, 
        result: ConfirmationResult, 
        args: dict
    ):
        """外部调用提交结果"""
        self._results[req_id] = (result, args)
        if req_id in self._pending:
            self._pending[req_id].set()
```

### 3.4 集成到 Agent

```python
@dataclass
class Agent:
    # ... 现有字段 ...
    confirmation_handler: Optional[ConfirmationHandler] = None
    
    # 敏感工具列表（也可以从工具属性读取）
    sensitive_tools: list[str] = field(default_factory=list)


# 在 Model.run_function_call 中添加确认逻辑
def run_function_call(
    self,
    function_call: FunctionCall,
    confirmation_handler: Optional[ConfirmationHandler] = None,
    **kwargs
):
    func = function_call.function
    
    # 检查是否需要确认
    needs_confirmation = (
        getattr(func, 'requires_confirmation', False) or
        func.name in kwargs.get('sensitive_tools', [])
    )
    
    if needs_confirmation and confirmation_handler:
        request = ConfirmationRequest(
            tool_name=func.name,
            arguments=function_call.arguments,
            context=kwargs.get('context', '')
        )
        
        result, modified_args = confirmation_handler.request_confirmation(request)
        
        if result == ConfirmationResult.REJECTED:
            return Message(
                role="tool",
                content="Operation cancelled by user",
                tool_call_id=function_call.call_id,
                tool_name=func.name
            )
        elif result == ConfirmationResult.MODIFIED:
            function_call.arguments = modified_args
        elif result == ConfirmationResult.TIMEOUT:
            return Message(
                role="tool",
                content="Operation timed out waiting for confirmation",
                tool_call_id=function_call.call_id,
                tool_name=func.name
            )
    
    # 执行工具
    return self._execute_function_call(function_call)
```

### 3.5 使用示例

```python
from sakura import Agent
from sakura.hitl import ConsoleConfirmationHandler

# 创建带确认的 Agent
agent = Agent(
    model="qwen-plus",
    tools=[read_file, write_file, delete_file, bash],
    confirmation_handler=ConsoleConfirmationHandler(),
    sensitive_tools=["delete_file", "bash"]
)

# 运行
result = agent.run("删除 /tmp/test.txt 文件")
# 会在执行 delete_file 前暂停等待确认
```

### 3.6 Web API 集成示例

```python
from fastapi import FastAPI, WebSocket
from sakura import Agent
from sakura.hitl import CallbackConfirmationHandler

app = FastAPI()
websocket_manager = WebSocketManager()

def on_confirmation_needed(data):
    """通过 WebSocket 通知前端"""
    websocket_manager.broadcast({
        "type": "confirmation_required",
        "data": data
    })

handler = CallbackConfirmationHandler(on_confirmation_needed)

@app.post("/agent/run")
async def run_agent(prompt: str):
    agent = Agent(
        model="qwen-plus",
        tools=[...],
        confirmation_handler=handler
    )
    result = await agent.arun(prompt)
    return {"result": result.content}

@app.post("/agent/confirm/{req_id}")
async def confirm_action(req_id: str, approved: bool, args: dict = None):
    if approved:
        handler.submit_result(
            req_id, 
            ConfirmationResult.APPROVED if args is None else ConfirmationResult.MODIFIED,
            args or {}
        )
    else:
        handler.submit_result(req_id, ConfirmationResult.REJECTED, {})
    return {"status": "ok"}
```

---

## 4. 配置模式

### 4.1 工具级别配置

```python
# 始终需要确认
@tool(requires_confirmation=True)
def dangerous_operation(...): ...

# 条件确认
@tool(requires_confirmation=lambda args: args.get("force", False))
def delete_with_force(path: str, force: bool = False): ...

# 无需确认
@tool(requires_confirmation=False)
def read_file(path: str): ...
```

### 4.2 Agent 级别配置

```python
agent = Agent(
    # 全局敏感工具列表
    sensitive_tools=["bash", "delete_file", "sql_execute"],
    
    # 确认处理器
    confirmation_handler=ConsoleConfirmationHandler(),
    
    # 确认超时
    confirmation_timeout=300,
    
    # 超时后行为
    on_confirmation_timeout="reject"  # 或 "approve", "ask_again"
)
```

### 4.3 策略配置

```yaml
# confirmation_policy.yaml
default: reject  # 默认不需要确认的工具返回 reject 还是 approve

tools:
  bash:
    requires_confirmation: true
    timeout: 60
    
  delete_file:
    requires_confirmation: true
    condition: "path.startswith('/important')"
    
  write_file:
    requires_confirmation: false
    
patterns:
  - match: "*_production*"
    requires_confirmation: true
```

---

## 5. 最佳实践

### 5.1 确认粒度

| 粒度 | 示例 | 适用场景 |
|------|------|----------|
| **工具级** | `delete_file` 始终确认 | 高危操作 |
| **参数级** | 路径含 `/prod` 时确认 | 条件限制 |
| **结果级** | 预览结果后确认执行 | 复杂操作 |

### 5.2 用户体验

```python
# 好的确认提示
ConfirmationRequest(
    tool_name="bash",
    arguments={"command": "rm -rf /data/*"},
    context="""
⚠️ 危险操作警告

此命令将删除 /data 目录下的所有文件。

影响范围：
- 约 1,234 个文件
- 约 5.6 GB 数据

此操作不可撤销！
"""
)
```

### 5.3 异步审批

```python
# 对于非紧急操作，支持异步审批
async def async_confirmation_flow(request: ConfirmationRequest):
    # 发送通知（邮件/Slack/钉钉）
    await send_notification(
        channel="ops-team",
        message=f"Agent 请求执行: {request.tool_name}"
    )
    
    # 记录请求
    await save_pending_request(request)
    
    # 不阻塞，返回 pending 状态
    return {"status": "pending", "request_id": request.id}
```

---

## 6. 与其他功能的关系

| 功能 | 关系 |
|------|------|
| **Task Tool** | 可在任务状态更新时触发确认 |
| **SubAgent** | SubAgent 的敏感操作也需要确认 |
| **Error Handling** | 确认超时视为一种错误 |
| **Observability** | 记录所有确认请求和结果 |
