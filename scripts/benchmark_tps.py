#!/usr/bin/env python3
"""TPS Benchmark for Modal GLM-5-FP8

Usage: python scripts/benchmark_tps.py [--prompt "text"] [--max-tokens 100] [--runs 3]
"""

import argparse
import time
import statistics
from dataclasses import dataclass


@dataclass
class BenchmarkResult:
    prompt: str
    output_tokens: int
    generation_time: float
    tps: float


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def run_modal_inference(prompt: str, max_tokens: int = 100) -> tuple[str, float]:
    try:
        import modal
    except ImportError:
        print("Error: modal package not installed. Run: pip install modal")
        raise
    
    start_time = time.perf_counter()
    
    try:
        model = modal.Cls.from_name("zai-org-glm-5-fp8", "Model")
        response = model.generate.remote(prompt, max_tokens=max_tokens)
    except Exception as e:
        print(f"Modal call failed: {e}")
        print("Update Cls.from_name() with your Modal app/class name.")
        raise
    
    elapsed = time.perf_counter() - start_time
    return response, elapsed


def benchmark_tps(prompt: str, max_tokens: int = 100, runs: int = 3, warmup: bool = True) -> list[BenchmarkResult]:
    results = []
    
    if warmup:
        print("🔥 Warmup run...")
        try:
            run_modal_inference(prompt, max_tokens)
            print("✅ Warmup complete\n")
        except Exception as e:
            print(f"⚠️ Warmup failed: {e}\n")
    
    for i in range(1, runs + 1):
        print(f"📊 Run {i}/{runs}...")
        
        try:
            response, elapsed = run_modal_inference(prompt, max_tokens)
            output_tokens = estimate_tokens(response)
            tps = output_tokens / elapsed if elapsed > 0 else 0
            
            results.append(BenchmarkResult(
                prompt=prompt,
                output_tokens=output_tokens,
                generation_time=elapsed,
                tps=tps
            ))
            
            print(f"   ⏱️  Time: {elapsed:.2f}s")
            print(f"   📝 Tokens: ~{output_tokens}")
            print(f"   🚀 TPS: {tps:.2f} tokens/sec\n")
            
        except Exception as e:
            print(f"   ❌ Failed: {e}\n")
    
    return results


def print_summary(results: list[BenchmarkResult]):
    if not results:
        print("No successful runs to summarize.")
        return
    
    tps_values = [r.tps for r in results]
    times = [r.generation_time for r in results]
    
    print("=" * 50)
    print("📈 BENCHMARK SUMMARY")
    print("=" * 50)
    print(f"Runs: {len(results)}")
    print(f"\n⏱️  Generation Time:")
    print(f"   Mean: {statistics.mean(times):.2f}s")
    print(f"   Min:  {min(times):.2f}s")
    print(f"   Max:  {max(times):.2f}s")
    if len(results) > 1:
        print(f"   Std:  {statistics.stdev(times):.2f}s")
    
    print(f"\n🚀 Tokens Per Second:")
    print(f"   Mean: {statistics.mean(tps_values):.2f} tps")
    print(f"   Min:  {min(tps_values):.2f} tps")
    print(f"   Max:  {max(tps_values):.2f} tps")
    if len(results) > 1:
        print(f"   Std:  {statistics.stdev(tps_values):.2f} tps")
    
    print(f"\n📝 Average Output Length: ~{statistics.mean([r.output_tokens for r in results]):.0f} tokens")
    print("=" * 50)


def main():
    parser = argparse.ArgumentParser(
        description="Benchmark TPS for Modal GLM-5-FP8"
    )
    parser.add_argument(
        "--prompt", "-p",
        default="Write a short poem about artificial intelligence.",
        help="Prompt to send to the model"
    )
    parser.add_argument(
        "--max-tokens", "-m",
        type=int,
        default=100,
        help="Maximum tokens to generate (default: 100)"
    )
    parser.add_argument(
        "--runs", "-r",
        type=int,
        default=3,
        help="Number of benchmark runs (default: 3)"
    )
    parser.add_argument(
        "--no-warmup",
        action="store_true",
        help="Skip warmup run"
    )
    
    args = parser.parse_args()
    
    print("🔬 MODAL GLM-5-FP8 TPS BENCHMARK")
    print("=" * 50)
    print(f"Prompt: {args.prompt[:60]}{'...' if len(args.prompt) > 60 else ''}")
    print(f"Max tokens: {args.max_tokens}")
    print(f"Runs: {args.runs}")
    print(f"Warmup: {not args.no_warmup}")
    print("=" * 50)
    print()
    
    results = benchmark_tps(
        prompt=args.prompt,
        max_tokens=args.max_tokens,
        runs=args.runs,
        warmup=not args.no_warmup
    )
    
    print_summary(results)


if __name__ == "__main__":
    main()
