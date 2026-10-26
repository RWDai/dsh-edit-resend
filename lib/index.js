/**
 * dsh-edit-resend —— host 半。
 *
 * 「编辑历史消息并从该处重跑」的全部逻辑都发生在浏览器侧：
 *   fork（session.fork）与重发（session.prompt）走的是客户端 Remote 直连宿主
 *   的既有 RPC，不经过这个包；会话日志原样保留在 DSH 自己的存储里。
 * 所以这里只提供一个可选的健康检查端点，安装后可以确认插件确实被装载。
 *
 * 依赖保持为可选：组合里没有 webServer 时插件照常加载，只是少了 /health。
 */

/** cordis 插件名。 */
export const name = 'dsh-edit-resend';

/** 不强制注入任何服务；webServer 在 apply 里按可选依赖解析。 */
export const inject = [];

/** 最近一次浏览器半上报的时间戳；用来确认客户端 bundle 真的跑起来了。 */
let lastClientAt;

/**
 * 装载 host 半。
 * @param {object} ctx cordis host 上下文。
 */
export function apply(ctx) {
  const register = (scoped) => {
    if (typeof scoped?.effect !== 'function' || typeof scoped?.webServer?.register !== 'function') return;
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: '/plugin/dsh-edit-resend/health',
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { allow: 'GET, HEAD' });
              res.end();
              return;
            }
            // 浏览器半装载后打一次卡，让「插件是否真的跑起来」可以从服务端确认。
            if (typeof req.url === 'string' && req.url.includes('client=1')) lastClientAt = new Date().toISOString();
            const body = JSON.stringify({
              ok: true,
              plugin: 'dsh-edit-resend',
              version: '0.1.2',
              clientSeenAt: lastClientAt ?? null,
            });
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(body),
            });
            if (req.method === 'HEAD') res.end();
            else res.end(body);
          },
        }),
      'dsh-edit-resend: health route',
    );
  };

  // webServer 可能在 apply 之后才就绪，用 inject 等它，而不是抢跑。
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], register);
  else register(ctx);
}
