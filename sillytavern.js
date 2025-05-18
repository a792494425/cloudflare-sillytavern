// --- 配置区域 ---
const TARGET_BASE_URL = "https://waclkgnwuvin.ap-northeast-1.clawcloudrun.com"; // SillyTavern 的目标后端地址
// 假设目标后端使用 HTTPS
const TARGET_SCHEME = new URL(TARGET_BASE_URL).protocol.slice(0, -1); // 从 TARGET_BASE_URL 自动提取 http 或 https

// --- 日志记录函数 (可选，用于调试) ---
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// --- Cloudflare Worker 入口 ---
export default {
  async fetch(request /*: Request */, env /*: Env */, ctx /*: ExecutionContext */) /*: Promise<Response> */ {
    const originalUrl = new URL(request.url);

    // 判断是否为 WebSocket 升级请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return handleWebSocket(request, originalUrl);
    } else {
      // 处理普通的 HTTP/HTTPS 请求
      return handleHttpRequest(request, originalUrl);
    }
  },
};

// --- HTTP/HTTPS 请求处理函数 ---
async function handleHttpRequest(request, originalUrl) {
  // 构建指向目标服务器的完整 URL
  const targetUrl = new URL(TARGET_BASE_URL);
  targetUrl.pathname = originalUrl.pathname;
  targetUrl.search = originalUrl.search;

  log(`HTTP Request: ${request.method} ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  // 准备新的请求头
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Host', targetUrl.hostname); // 非常重要：设置目标服务器的 Host 头部

  // 对于 SillyTavern，通常不需要像之前讨论的那样强制修改 User-Agent 或 Origin
  // 除非您发现目标后端 (clawcloudrun.com 或其后的服务) 对此有特殊要求。
  // 默认情况下，透传客户端的 User-Agent 和 Origin (如果存在) 是更透明的做法。

  // 清理一些 Cloudflare 特有的、不应发送到源的头部
  requestHeaders.delete('cf-connecting-ip');
  requestHeaders.delete('cf-ipcountry');
  requestHeaders.delete('cf-ray');
  requestHeaders.delete('cf-visitor');
  requestHeaders.delete('x-real-ip'); // 通常由 cf-connecting-ip 代替
  requestHeaders.delete('cdn-loop');


  let originResponse;
  try {
    originResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: requestHeaders,
      body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
      redirect: 'manual', // 与您脚本中的设置一致，代理将重定向传递给客户端处理
    });

    // 复制响应头以便修改
    const responseHeaders = new Headers(originResponse.headers);

    // 添加 CORS 头部 - 请根据您的 SillyTavern 前端域名调整 Access-Control-Allow-Origin
    // 如果您的 SillyTavern 前端和此 Worker 在不同域名下，则需要设置
    responseHeaders.set('Access-Control-Allow-Origin', '*'); // 或者替换为您的SillyTavern前端域名，例如 "https://my-sillytavern-frontend.com"
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    // SillyTavern 可能需要一些特定的头部，确保它们被允许
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Stream-Output, Sec-WebSocket-Protocol');
    // 如果您的 SillyTavern 需要凭据 (例如 cookies 或 Authorization)，并且 Access-Control-Allow-Origin 不是 "*"，
    // 则可以取消注释下一行。注意：当 ACAO 为 "*" 时，不允许 credentials 为 true。
    // responseHeaders.set('Access-Control-Allow-Credentials', 'true');

    // 处理源服务器的重定向响应
    if (originResponse.status >= 300 && originResponse.status < 400 && originResponse.headers.has('location')) {
      // 对于简单的1:1代理，直接返回通常没问题。
      // 如果您的 Worker 部署在子路径下，而目标服务的重定向是绝对路径，可能需要调整 location。
      return new Response(null, {
        status: originResponse.status,
        headers: responseHeaders, // responseHeaders 已包含从 originResponse 复制的 location
      });
    }

    // 创建新的响应对象并返回
    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders,
    });

  } catch (e) {
    log(`CF Worker HTTP Proxy fetch error: ${e.name} - ${e.message}`);
    return new Response(`Proxy error: Could not connect to target service. (${e.message})`, { status: 502 });
  }
}

// --- WebSocket 请求处理函数 ---
async function handleWebSocket(request, originalUrl) {
  const targetUrl = new URL(TARGET_BASE_URL);
  targetUrl.pathname = originalUrl.pathname; // 例如 SillyTavern 的 /api/v1/stream 或 /api/events/stream
  targetUrl.search = originalUrl.search;
  targetUrl.protocol = targetUrl.protocol.replace('http', 'ws'); // http -> ws, https -> wss

  log(`WebSocket Upgrade: ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  const webSocketPair = new WebSocketPair();
  const clientWs = webSocketPair[0]; // 连接到客户端浏览器的 WebSocket
  const serverWs = webSocketPair[1]; // Worker 内部的 WebSocket，用于连接到源服务器

  serverWs.accept(); // 必须调用，以接受来自 Worker runtime 的连接

  // 准备发往源 WebSocket 服务器的头部
  const originWsHeaders = new Headers();
  originWsHeaders.set('Host', targetUrl.hostname);       // 目标主机名
  originWsHeaders.set('Upgrade', 'websocket');        // 标准 WebSocket 升级请求
  // originWsHeaders.set('Connection', 'Upgrade');     // fetch 通常会自动处理

  // 透传客户端的 Sec-WebSocket-* 相关头部
  if (request.headers.has('Sec-WebSocket-Key')) originWsHeaders.set('Sec-WebSocket-Key', request.headers.get('Sec-WebSocket-Key'));
  if (request.headers.has('Sec-WebSocket-Version')) originWsHeaders.set('Sec-WebSocket-Version', request.headers.get('Sec-WebSocket-Version'));
  if (request.headers.has('Sec-WebSocket-Protocol')) originWsHeaders.set('Sec-WebSocket-Protocol', request.headers.get('Sec-WebSocket-Protocol'));

  // 对于 User-Agent 和 Origin，通常建议透传客户端的原始值，以保持透明性
  // 除非目标服务器 (clawcloudrun.com 或其后的服务) 对这些有特殊要求
  if (request.headers.has('User-Agent')) originWsHeaders.set('User-Agent', request.headers.get('User-Agent'));
  if (request.headers.has('Origin')) {
    originWsHeaders.set('Origin', request.headers.get('Origin'));
  } else {
    // 如果客户端没有发送 Origin (例如非浏览器客户端)，
    // 某些服务器可能仍期望一个 Origin。如果遇到问题，可以尝试设置一个默认的：
    // originWsHeaders.set('Origin', new URL(TARGET_BASE_URL).origin);
  }

  try {
    // 使用 fetch API 连接到源 WebSocket 服务器
    const originResponse = await fetch(targetUrl.toString(), {
      headers: originWsHeaders,
      // WebSocket 的 fetch 不需要 method 或 body
    });

    const originSocket = originResponse.webSocket; // 获取源服务器的 WebSocket 连接
    if (!originSocket) {
      log(`WebSocket origin did not upgrade. Status: ${originResponse.status}. URL: ${targetUrl.toString()}`);
      let errorBody = `WebSocket origin did not upgrade. Status: ${originResponse.status}.`;
      try { errorBody += " Body: " + await originResponse.text(); } catch (e) {}
      serverWs.close(1011, "Origin did not upgrade to WebSocket"); // 关闭 serverWs 端
      return new Response(errorBody, { status: originResponse.status, headers: originResponse.headers });
    }

    originSocket.accept(); // 接受来自源服务器的 WebSocket 连接

    // 在 clientWs (通过 serverWs) 和 originSocket 之间双向传递消息、关闭和错误事件
    originSocket.addEventListener('message', event => {
      try {
        if (serverWs.readyState === WebSocket.OPEN) serverWs.send(event.data);
      } catch (e) { log(`Error serverWs.send: ${e}`); }
    });
    serverWs.addEventListener('message', event => {
      try {
        if (originSocket.readyState === WebSocket.OPEN) originSocket.send(event.data);
      } catch (e) { log(`Error originSocket.send: ${e}`); }
    });

    // 通用的关闭和错误处理逻辑
    const commonCloseOrErrorHandler = (wsSide /*: 'Origin' | 'Client' */, otherWs /*: WebSocket */, event /*: CloseEvent | Event */, type /*: 'close' | 'error' */) => {
      const code = event.code || (type === 'error' ? 1011 : 1000); // 1011 server error, 1000 normal
      const reason = event.reason || (type === 'error' ? 'Error encountered' : 'Connection closed');
      log(`${wsSide} WebSocket ${type}: Code ${code}, Reason: '${reason}'`);
      // 如果另一端还处于打开或连接状态，则用相同的代码和原因关闭它
      if (otherWs.readyState === WebSocket.OPEN || otherWs.readyState === WebSocket.CONNECTING) {
        otherWs.close(code, reason);
      }
    };

    originSocket.addEventListener('close', event => commonCloseOrErrorHandler('Origin', serverWs, event, 'close'));
    serverWs.addEventListener('close', event => commonCloseOrErrorHandler('Client', originSocket, event, 'close'));
    originSocket.addEventListener('error', event => commonCloseOrErrorHandler('Origin', serverWs, event, 'error')); // 对于 error 事件，event 对象可能没有 code/reason
    serverWs.addEventListener('error', event => commonCloseOrErrorHandler('Client', originSocket, event, 'error'));

    // 准备并返回给客户端的 101 Switching Protocols 响应
    const responseHeaders = new Headers();
    // 如果源服务器选择了子协议，将其通过响应头传回给客户端
    if (originResponse.headers.has('sec-websocket-protocol')) {
      responseHeaders.set('sec-websocket-protocol', originResponse.headers.get('sec-websocket-protocol'));
    }

    return new Response(null, {
      status: 101,
      webSocket: clientWs, // 将 clientWs (连接到客户端浏览器的那一端) 交给 Cloudflare runtime
      headers: responseHeaders,
    });

  } catch (error) {
    log(`WebSocket connection to origin error: ${error.name} - ${error.message}`);
    // 确保 serverWs 被关闭，以防错误发生在 originSocket 建立之前或期间
    if (serverWs && serverWs.readyState !== WebSocket.CLOSED && serverWs.readyState !== WebSocket.CLOSING) {
        serverWs.close(1011, `Proxy to origin failed: ${error.message}`);
    }
    return new Response(`WebSocket Proxy Error: ${error.message}`, { status: 502 }); // Bad Gateway 更合适
  }
}

