// 主动停止必须结束进程，不能依赖 Node 的活动句柄自然清空。
export function createBoundedShutdown({ cleanup, exit = (code) => process.exit(code),
  timeoutMs = 10_000, log = console.error }) {
  let pending;
  return function shutdown() {
    if (pending) return pending;
    const timer = setTimeout(() => {
      log('CCM Worker 停止超时，强制退出以交回 Supervisor。');
      exit(1);
    }, timeoutMs);
    pending = Promise.resolve().then(cleanup).then(() => {
      clearTimeout(timer);
      exit(0);
    }, (error) => {
      clearTimeout(timer);
      log('CCM Worker 停止失败：', error);
      exit(1);
    });
    return pending;
  };
}
