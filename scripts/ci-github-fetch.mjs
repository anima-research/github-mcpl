// Offline startup fixture, loaded only by ci-start-check.mjs. Unknown requests
// fail rather than escaping to the network. Production never imports this file.
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  let body;
  if (init?.method === 'GET' && path === '/repos/example/repo/installation') body = { id: 42 };
  else if (init?.method === 'POST' && path === '/app/installations/42/access_tokens') {
    body = { token: 'offline-start-test', expires_at: new Date(Date.now() + 3600000).toISOString() };
  } else if (init?.method === 'GET' && /^\/repos\/example\/(repo|other)$/.test(path)) {
    const scenario = process.env.CI_START_SCENARIO;
    if (scenario === 'missing' || scenario === 'all-missing') return Response.json({ message: 'Not Found' }, { status: 404 });
    if (scenario === 'transient') return Response.json({ message: 'Unavailable' }, { status: 503 });
    body = { full_name: scenario === 'renamed' ? 'example/renamed' : 'example/repo' };
  }
  else throw new Error(`unexpected offline startup request: ${init?.method} ${path}`);
  return Response.json(body);
};
