
import time
import statistics
import timeit
import sys
import os
import asyncio
from dataclasses import dataclass
from typing import Any, List, Optional, Dict

# Add project parent directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))


from sakura.agent import Agent
from sakura.models.base import Model
from sakura.messages.message import Message
from sakura.messages.response import ModelResponse
from sakura.messages.metrics import Metrics
from sakura.tools import tool

# 1. Mock Model for detailed simulation
@dataclass
class SimulationModel(Model):
    id: str = "simulation-model"
    latency_ms: float = 0.0  # Simulated network latency
    
    def invoke(self, messages: List[Message], tools: Optional[List[Dict]] = None, **kwargs) -> ModelResponse:
        if self.latency_ms > 0:
            time.sleep(self.latency_ms / 1000)
            
        return ModelResponse(
            content="Simulation response.",
            response_usage=Metrics(input_tokens=50, output_tokens=50)
        )
        
    async def ainvoke(self, messages: List[Message], tools: Optional[List[Dict]] = None, **kwargs) -> ModelResponse:
        if self.latency_ms > 0:
            await asyncio.sleep(self.latency_ms / 1000)
            
        return ModelResponse(
            content="Simulation response.",
            response_usage=Metrics(input_tokens=50, output_tokens=50)
        )

    def invoke_stream(self, messages: List[Message], tools: Optional[List[Dict]] = None, **kwargs) -> Any:
        yield self.invoke(messages, tools, **kwargs)

    async def ainvoke_stream(self, messages: List[Message], tools: Optional[List[Dict]] = None, **kwargs) -> Any:
        yield await self.invoke(messages, tools, **kwargs)
        
    def _parse_provider_response(self, response: Any, **kwargs) -> ModelResponse:
        return response
        
    def _parse_provider_response_delta(self, response: Any) -> ModelResponse:
        return response

# 2. Dummy Tools
@tool
def heavy_computation(n: int) -> int:
    """Simulates CPU bound task."""
    return sum(range(n))

@tool
def complex_schema_tool(
    name: str,
    age: int,
    preferences: Dict[str, Any],
    history: List[str]
) -> str:
    """Tool with complex schema to test serialization overhead."""
    return "ok"

# 3. Benchmark Logic
async def run_throughput_test(agent, n_requests: int):
    """Test throughput with async execution."""
    start = time.perf_counter()
    tasks = [agent.arun("test") for _ in range(n_requests)]
    await asyncio.gather(*tasks)
    duration = time.perf_counter() - start
    return n_requests / duration  # RPS

def run_latency_test(agent, n_runs: int):
    times = []
    for _ in range(n_runs):
        start = time.perf_counter()
        agent.run("test")
        times.append((time.perf_counter() - start) * 1000)
    return times

def print_stats(times, label):
    mean = statistics.mean(times)
    p50 = sorted(times)[int(len(times) * 0.50)]
    p95 = sorted(times)[int(len(times) * 0.95)]
    p99 = sorted(times)[int(len(times) * 0.99)]
    print(f"\n{label}:")
    print(f"  Mean: {mean:.3f} ms")
    print(f"  P50:  {p50:.3f} ms")
    print(f"  P95:  {p95:.3f} ms")
    print(f"  P99:  {p99:.3f} ms")

def run_comprehensive_benchmark():
    print("🚀 Starting Comprehensive Benchmark Suite\n")
    
    # Setup
    tools = [heavy_computation, complex_schema_tool]
    model = SimulationModel(latency_ms=0) # Pure framework overhead
    
    agent_default = Agent(model=model, tools=tools, performance_mode=True) # Now default is True, but explicit here
    agent_legacy = Agent(model=model, tools=tools, performance_mode=False, enable_monitoring=True) # Force old way
    
    n_runs = 500
    
    # 1. Latency Test (Sequential)
    print("1. Sequential Latency Test (Framework Overhead)")
    print("-" * 50)
    
    # Warmup
    agent_default.run("warmup")
    agent_legacy.run("warmup")
    
    legacy_times = run_latency_test(agent_legacy, n_runs)
    default_times = run_latency_test(agent_default, n_runs)
    
    print_stats(legacy_times, "Legacy Mode (Monitoring + No Cache)")
    print_stats(default_times, "Performance Mode (Default)")
    
    # 2. Concurrency/Throughput Test
    print("\n2. Async Throughput Test (Simulated 50 concurrent requests)")
    print("-" * 50)
    
    n_concurrent = 200
    
    # We need a new loop for async test if running in sync context
    # But here we invoke inside asyncio.run if main
    pass # logic handles below

    async def async_main():
        legacy_rps = await run_throughput_test(agent_legacy, n_concurrent)
        default_rps = await run_throughput_test(agent_default, n_concurrent)
        
        print(f"\nThroughput (Requests Per Second):")
        print(f"  Legacy Mode:      {legacy_rps:.2f} RPS")
        print(f"  Performance Mode: {default_rps:.2f} RPS")
        print(f"  Improvement:      {default_rps / legacy_rps:.2f}x")

    asyncio.run(async_main())

    # 3. Message History Scaling
    print("\n3. Large Context scaling (100 msg history)")
    print("-" * 50)
    
    history = [Message(role="user", content="msg") for _ in range(100)]
    
    start = time.perf_counter()
    agent_legacy.run("test", messages=history)
    legacy_scale_time = (time.perf_counter() - start) * 1000
    
    start = time.perf_counter()
    agent_default.run("test", messages=history)
    default_scale_time = (time.perf_counter() - start) * 1000
    
    print(f"Legacy (Deep Copy):   {legacy_scale_time:.3f} ms")
    print(f"Default (Zero Copy):  {default_scale_time:.3f} ms")


if __name__ == "__main__":
    run_comprehensive_benchmark()
