'use strict';

const endpoints = [
  { name: 'Gateway', url: 'http://localhost:8080/health' },
  { name: 'Dashboard', url: 'http://localhost:3000/health' },
  { name: 'Identity', url: 'http://localhost:8001/health' },
  { name: 'Driver', url: 'http://localhost:8002/health' },
  { name: 'Trip', url: 'http://localhost:8003/health' },
  { name: 'Matching', url: 'http://localhost:8004/health' },
  { name: 'Payment', url: 'http://localhost:8005/health' },
  { name: 'Notification', url: 'http://localhost:8006/health' },
  { name: 'RabbitMQ', url: 'http://localhost:15672' },
];

async function main() {
  console.log('='.repeat(70));
  console.log(' KIỂM TRA TRỰC TIẾP TRẠNG THÁI CÁC DỊCH VỤ ĐANG CHẠY (DOCKER LIVE)');
  console.log('='.repeat(70));

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, { signal: AbortSignal.timeout(3000) });
      const text = await res.text();
      console.log(`✅ [HTTP ${res.status}] ${ep.name.padEnd(14)}: ${ep.url} -> ${text.substring(0, 50).trim()}`);
    } catch (err) {
      console.error(`❌ [ERROR]    ${ep.name.padEnd(14)}: ${ep.url} -> ${err.message}`);
    }
  }
  console.log('='.repeat(70));
}

main();
