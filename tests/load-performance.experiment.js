'use strict';

/**
 * DS03: Load & Performance Experiment Runner
 * Assigned to: TV3 (Quang)
 * Measures: Throughput (RPS), Latency percentiles (p50, p90, p95, p99), Error Rate, Memory/CPU
 */

const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const TARGET_HOST = process.env.BENCHMARK_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.BENCHMARK_PORT || 8080);
const TARGET_PATH = process.env.BENCHMARK_PATH || '/health';
const CONCURRENCY = Number(process.env.BENCHMARK_CONCURRENCY || 20);
const TOTAL_REQUESTS = Number(process.env.BENCHMARK_REQUESTS || 500);

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const index = Math.ceil((p / 100) * arr.length) - 1;
  return arr[Math.max(0, Math.min(index, arr.length - 1))];
}

function makeRequest() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const corrId = `corr_bench_${crypto.randomUUID()}`;

    const req = http.request(
      {
        hostname: TARGET_HOST,
        port: TARGET_PORT,
        path: TARGET_PATH,
        method: 'GET',
        headers: {
          'X-Correlation-ID': corrId,
          Connection: 'keep-alive',
        },
        timeout: 5000,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          const end = process.hrtime.bigint();
          const latencyMs = Number(end - start) / 1e6;
          resolve({
            success: res.statusCode >= 200 && res.statusCode < 400,
            statusCode: res.statusCode,
            latencyMs,
          });
        });
      }
    );

    req.on('error', (err) => {
      const end = process.hrtime.bigint();
      resolve({
        success: false,
        statusCode: 0,
        latencyMs: Number(end - start) / 1e6,
        error: err.message,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const end = process.hrtime.bigint();
      resolve({
        success: false,
        statusCode: 504,
        latencyMs: Number(end - start) / 1e6,
        error: 'TIMEOUT',
      });
    });

    req.end();
  });
}

async function runBenchmark() {
  console.log('='.repeat(70));
  console.log(' DS03 LOAD & PERFORMANCE EXPERIMENT (TV3 MODULE)');
  console.log('='.repeat(70));
  console.log(` Target Endpoint : http://${TARGET_HOST}:${TARGET_PORT}${TARGET_PATH}`);
  console.log(` Concurrency     : ${CONCURRENCY} workers`);
  console.log(` Total Requests  : ${TOTAL_REQUESTS}`);
  console.log(` OS Platform     : ${os.type()} ${os.release()} (${os.arch()})`);
  console.log(` CPU Cores       : ${os.cpus().length} x ${os.cpus()[0]?.model || 'CPU'}`);
  console.log(` System RAM      : ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB (Free: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB)`);
  console.log('-'.repeat(70));

  const latencies = [];
  let successCount = 0;
  let failCount = 0;
  let sentCount = 0;

  const startTime = Date.now();

  async function worker() {
    while (sentCount < TOTAL_REQUESTS) {
      sentCount++;
      const res = await makeRequest();
      latencies.push(res.latencyMs);
      if (res.success) {
        successCount++;
      } else {
        failCount++;
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const durationSec = (Date.now() - startTime) / 1000;
  latencies.sort((a, b) => a - b);

  const rps = (latencies.length / durationSec).toFixed(2);
  const minLatency = latencies[0]?.toFixed(2) || '0';
  const maxLatency = latencies[latencies.length - 1]?.toFixed(2) || '0';
  const meanLatency = (latencies.reduce((sum, v) => sum + v, 0) / latencies.length).toFixed(2);
  const p50 = percentile(latencies, 50).toFixed(2);
  const p90 = percentile(latencies, 90).toFixed(2);
  const p95 = percentile(latencies, 95).toFixed(2);
  const p99 = percentile(latencies, 99).toFixed(2);
  const errorRate = ((failCount / latencies.length) * 100).toFixed(2);

  const memUsage = process.memoryUsage();

  console.log('\n[KẾT QUẢ ĐO ĐẠC HIỆU NĂNG - BENCHMARK RESULTS]');
  console.log(` • Tổng số request hoàn tất : ${latencies.length}`);
  console.log(` • Thành công               : ${successCount}`);
  console.log(` • Thất bại / Lỗi           : ${failCount} (Tỷ lệ lỗi: ${errorRate}%)`);
  console.log(` • Thời gian thực thi       : ${durationSec.toFixed(2)} giây`);
  console.log(` • Throughput (RPS)         : ${rps} req/sec`);
  console.log('-'.repeat(70));
  console.log('[PHÂN BỐ ĐỘ TRỄ - LATENCY DISTRIBUTION]');
  console.log(` • Min Latency              : ${minLatency} ms`);
  console.log(` • Mean Latency             : ${meanLatency} ms`);
  console.log(` • p50 (Median)             : ${p50} ms`);
  console.log(` • p90                      : ${p90} ms`);
  console.log(` • p95                      : ${p95} ms`);
  console.log(` • p99                      : ${p99} ms`);
  console.log(` • Max Latency              : ${maxLatency} ms`);
  console.log('-'.repeat(70));
  console.log('[TIÊU THỤ BỘ NHỚ TIẾN TRÌNH]');
  console.log(` • RSS                      : ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(` • Heap Used                : ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log('='.repeat(70));

  return {
    totalRequests: latencies.length,
    successCount,
    failCount,
    errorRate: Number(errorRate),
    durationSec: Number(durationSec.toFixed(2)),
    rps: Number(rps),
    latency: {
      min: Number(minLatency),
      mean: Number(meanLatency),
      p50: Number(p50),
      p90: Number(p90),
      p95: Number(p95),
      p99: Number(p99),
      max: Number(maxLatency),
    },
  };
}

if (require.main === module) {
  runBenchmark().catch(console.error);
}

module.exports = { runBenchmark };
