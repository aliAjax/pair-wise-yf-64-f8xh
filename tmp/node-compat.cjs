// 环境兼容垫片：本机 Node 20.20.2（OrbStack 构建）缺少 undici 8.x 需要的
// worker_threads.markAsUncloneable。用 no-op 补齐，仅影响无法被结构化克隆的标记，
// 不影响构建/开发服务器正常运行。
const workerThreads = require('node:worker_threads');
if (typeof workerThreads.markAsUncloneable !== 'function') {
  workerThreads.markAsUncloneable = function markAsUncloneable() {};
}
