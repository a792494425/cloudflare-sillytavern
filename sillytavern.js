// --- 配置区域 ---
// !!! 请将此 URL 替换为您的 SillyTavern 后端 AI 服务的实际地址 !!!
const TARGET_BASE_URL = "https://waclkgnwuvin.ap-northeast-1.clawcloudrun.com";

// 从 TARGET_BASE_URL 自动提取协议和主机名
const TARGET_URL_PARSED = new URL(TARGET_BASE_URL);
const TARGET_SCHEME = TARGET_URL_PARSED.protocol.slice(0, -1); // 'http' or 'https'
const TARGET_HOSTNAME = TARGET_URL_PARSED.hostname;

// --- 日志记录函数 (可选，用于调试) ---
function log(level, message, data = '') {
  const logMessage = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (data) {
    console[level.toLowerCase()] ? console[level.toLowerCase()](logMessage, data) : console.log(logMessage, data);
  } else {
    console[level.toLowerCase()] ? console[level.toLowerCase()](logMessage) : console.log(logMessage);
  }
}

// --- Cloudflare Worker 入口 ---
export default {
  async fetch(request /*: Request */, env /*: Env */, ctx /*: ExecutionContext */) /*: Promise<Response> */ {
    const originalUrl = new URL(request.url);

    // 判断是否为 WebSocket 升级请求 (SillyTavern 核心功能依赖)
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return handleWebSocket(request, originalUrl, ctx, env);
    } else {
      // 处理普通的 HTTP/HTTPS 请求 (API调用、静态资源等)
      return handleHttpRequest(request, originalUrl, ctx, env);
    }
  },
};

// --- HTTP/HTTPS 请求处理函数 ---
async function handleHttpRequest(request, originalUrl, ctx, env) {
  // 构建指向目标服务器的完整 URL
  // TARGET_URL_PARSED.pathname 可能包含基础路径 (如 /api/v1)
  // originalUrl.pathname 是 worker 收到的路径 (如 /chat)
  let basePath = TARGET_URL_PARSED.pathname;
  if (basePath.endsWith('/') && basePath !== '/') { // 保留根路径的 '/' 但移除其他基础路径的尾部 /
    basePath = basePath.slice(0, -1);
  }
  let requestPath = originalUrl.pathname;
  if (basePath === '/' && requestPath === '/') { // 如果目标是根，请求也是根，则最终路径就是 /
    //  no change needed for finalPath construction below
  } else if (basePath === '/') { // 如果目标是根，则直接使用请求路径
    //  no change needed for finalPath construction below, finalPath will be requestPath
  } else if (!requestPath.startsWith('/')) { // 确保请求路径以 / 开头，方便拼接
    requestPath = '/' + requestPath;
  }
  // 如果 basePath 是 "/" (例如 TARGET_BASE_URL 是 "https://host.com/"), 则 finalPath 就是 requestPath
  // 否则，finalPath 是 basePath 和 requestPath 的拼接
  const finalPath = (basePath === '/') ? requestPath : (basePath + requestPath);

  const targetUrl = new URL(finalPath, TARGET_BASE_URL); // 使用 URL 构造函数解析路径
  targetUrl.search = originalUrl.search; // 复制查询参数

  log('INFO', `HTTP Request: ${request.method} ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Host', TARGET_HOSTNAME);
  // 告知后端最初请求的主机和协议
  requestHeaders.set('X-Forwarded-Host', originalUrl.hostname);
  requestHeaders.set('X-Forwarded-Proto', originalUrl.protocol.slice(0, -1));
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) {
    requestHeaders.set('X-Forwarded-For', clientIp); // 设置客户端真实IP
  }

  // 清理一些 Cloudflare 特有的、不应发送到源的头部
  ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'cdn-loop', 'x-real-ip'].forEach(h => requestHeaders.delete(h));

  // 对于 SillyTavern 后端，通常透传客户端的 User-Agent 和 Origin 即可。
  // 如果您的后端 `waclkgnwuvin.ap-northeast-1.clawcloudrun.com` 对这些有特殊要求，
  // 例如需要固定的 Origin，可以在这里设置：
  // requestHeaders.set('Origin', TARGET_URL_PARSED.origin);
  // requestHeaders.set('User-Agent', 'SillyTavern/CF-Worker-Proxy');


  // --- 缓存策略 (示例，可选，默认不启用主动缓存) ---
  // SillyTavern 的 API 调用通常是动态的，不建议积极缓存，除非您非常了解哪些端点可以安全缓存。
  // 如果要启用，可以参考之前的 Cache API 示例，并小心配置。
  // const cache = caches.default;
  // let response = await cache.match(request.clone());
  // if (response) { log('INFO', `Cache hit: ${request.url}`); return response; }
  // log('INFO', `Cache miss: ${request.url}`);

  try {
    const originResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: requestHeaders,
      body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
      redirect: 'manual', // 代理将重定向传递给客户端处理
    });

    let responseHeaders = new Headers(originResponse.headers);

    // --- CORS 头部处理 ---
    const clientRequestOrigin = request.headers.get('Origin');
    if (clientRequestOrigin) {
      responseHeaders.set('Access-Control-Allow-Origin', clientRequestOrigin);
      responseHeaders.set('Vary', 'Origin');
    } else {
      // 对于非浏览器直接API调用，通常不需要ACAO，但如果需要，可以设为*或特定来源
      responseHeaders.set('Access-Control-Allow-Origin', '*'); // 生产环境建议替换为您的SillyTavern前端域名
    }
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, Accept, Origin, X-Requested-With, Sec-WebSocket-Protocol, Sec-WebSocket-Extensions, Sec-WebSocket-Key, Sec-WebSocket-Version, X-Custom-ST-Header'); // 添加一些SillyTavern可能用到的或自定义的头部
    responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Date, ETag, Vary, WWW-Authenticate'); // 暴露 WWW-Authenticate 以便处理401
    
    // 如果后端API或SillyTavern需要Cookie或Authorization头部进行认证，且ACAO不是'*'
    if (responseHeaders.get('Access-Control-Allow-Origin') !== '*') {
         responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    }

    // --- OPTIONS 请求预检处理 ---
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    if (originResponse.status >= 300 && originResponse.status < 400 && responseHeaders.has('location')) {
      log('INFO', `Redirecting: ${originResponse.status} to ${responseHeaders.get('location')}`);
      return new Response(null, { status: originResponse.status, headers: responseHeaders });
    }

    // --- 可选：添加一些基础安全响应头 ---
    if (!responseHeaders.has('X-Content-Type-Options')) responseHeaders.set('X-Content-Type-Options', 'nosniff');
    if (!responseHeaders.has('X-Frame-Options')) responseHeaders.set('X-Frame-Options', 'DENY');
    responseHeaders.delete('X-Powered-By'); // 移除可能的后端技术指纹

    // --- 缓存写回 (如果启用了上面的缓存读取逻辑) ---
    // if (request.method === 'GET' && originResponse.ok && appropriateCachingHeaders(originResponse.headers)) {
    //   ctx.waitUntil(cache.put(request.clone(), originResponse.clone()));
    // }

    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders,
    });

  } catch (e) {
    log('ERROR', `CF Worker HTTP Proxy fetch error: ${e.name} - ${e.message}. URL: ${targetUrl.toString()}`, e.stack);
    return new Response(`Proxy error to target service: ${e.message}`, { status: 502 });
  }
}

// --- WebSocket 请求处理函数 ---
async function handleWebSocket(request, originalUrl, ctx, env) {
  let basePath = TARGET_URL_PARSED.pathname;
   if (basePath.endsWith('/') && basePath !== '/') {
    basePath = basePath.slice(0, -1);
  }
  let requestPath = originalUrl.pathname;
  if (basePath === '/' && requestPath === '/') { /* keep / */ }
  else if (!requestPath.startsWith('/')) { requestPath = '/' + requestPath; }
  const finalPath = (basePath === '/') ? requestPath : (basePath + requestPath);

  const targetUrl = new URL(finalPath, TARGET_BASE_URL);
  targetUrl.search = originalUrl.search;
  targetUrl.protocol = TARGET_SCHEME === 'https' ? 'wss' : 'ws';

  log('INFO', `WebSocket Upgrade: ${originalUrl.pathname}${originalUrl.search} -> ${targetUrl.toString()}`);

  const webSocketPair = new WebSocketPair();
  const clientWs = webSocketPair[0];
  const serverWs = webSocketPair[1];

  serverWs.accept();

  const originWsHeaders = new Headers();
  originWsHeaders.set('Host', TARGET_HOSTNAME);
  originWsHeaders.set('Upgrade', 'websocket');

  // 透传对 WebSocket 握手很重要的头部
  // SillyTavern 后端 (如 Oobabooga) 可能依赖这些来正确建立连接
  const headersToForward = [
    'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol',
    'User-Agent', 'Origin', 'Cookie', 'Authorization' // 根据后端是否需要认证来决定是否透传 Cookie 和 Authorization
  ];
  for (const headerName of headersToForward) {
    if (request.headers.has(headerName)) {
      originWsHeaders.set(headerName, request.headers.get(headerName));
    }
  }
  // 如果您的 SillyTavern 后端 (waclkgnwuvin...) 对 Origin 有特殊要求，
  // 例如，即使客户端浏览器没有发送 Origin (理论上浏览器总会发送)，或者您想固定它：
  // if (!originWsHeaders.has('Origin') && TARGET_URL_PARSED.origin !== 'null' && TARGET_URL_PARSED.origin !== 'file://') {
  //   log('WARN', 'WebSocket: Forcing Origin header for target: ' + TARGET_URL_PARSED.origin);
  //   originWsHeaders.set('Origin', TARGET_URL_PARSED.origin);
  // }


  try {
    const originResponse = await fetch(targetUrl.toString(), {
      headers: originWsHeaders,
    });

    const originSocket = originResponse.webSocket;
    if (!originSocket) {
      log('ERROR', `WebSocket origin did not upgrade. Status: ${originResponse.status}. URL: ${targetUrl.toString()}`);
      let errorBody = `WebSocket origin did not upgrade. Status: ${originResponse.status}.`;
      try { errorBody += " Body: " + await originResponse.text(); } catch (e) {}
      serverWs.close(1011, "Origin did not upgrade to WebSocket");
      return new Response(errorBody, { status: originResponse.status, headers: originResponse.headers });
    }

    originSocket.accept();

    originSocket.addEventListener('message', event => {
      try {
        if (serverWs.readyState === WebSocket.OPEN) serverWs.send(event.data);
      } catch (e) { log('ERROR', `Error serverWs.send: ${e.message}`, e); }
    });
    serverWs.addEventListener('message', event => {
      try {
        if (originSocket.readyState === WebSocket.OPEN) originSocket.send(event.data);
      } catch (e) { log('ERROR', `Error originSocket.send: ${e.message}`, e); }
    });

    const commonCloseOrErrorHandler = (wsSide, otherWs, event, type) => {
      const code = event.code || (type === 'error' ? 1011 : 1000);
      const reason = event.reason || (type === 'error' ? `WebSocket error on ${wsSide}` : `WebSocket connection closed on ${wsSide}`);
      log('INFO', `${wsSide} WebSocket ${type}: Code ${code}, Reason: '${reason}'`);
      if (otherWs.readyState === WebSocket.OPEN || otherWs.readyState === WebSocket.CONNECTING) {
        otherWs.close(code, reason);
      }
    };

    originSocket.addEventListener('close', event => commonCloseOrErrorHandler('Origin', serverWs, event, 'close'));
    serverWs.addEventListener('close', event => commonCloseOrErrorHandler('Client', originSocket, event, 'close'));
    originSocket.addEventListener('error', event => commonCloseOrErrorHandler('Origin', serverWs, event, 'error'));
    serverWs.addEventListener('error', event => commonCloseOrErrorHandler('Client', originSocket, event, 'error'));
    
    const responseHeaders = new Headers();
    // 将源服务器选择的子协议传回给客户端
    if (originResponse.headers.has('sec-websocket-protocol')) {
        responseHeaders.set('sec-websocket-protocol', originResponse.headers.get('sec-websocket-protocol'));
    }

    return new Response(null, {
      status: 101,
      webSocket: clientWs,
      headers: responseHeaders,
    });

  } catch (error) {
    log('ERROR', `WebSocket connection to origin error: ${error.name} - ${error.message}`, error.stack);
    if (serverWs && serverWs.readyState !== WebSocket.CLOSED && serverWs.readyState !== WebSocket.CLOSING) {
        serverWs.close(1011, `Proxy to origin failed: ${error.message}`);
    }
    return new Response(`WebSocket Proxy Error: ${error.message}`, { status: 502 });
  }
}
