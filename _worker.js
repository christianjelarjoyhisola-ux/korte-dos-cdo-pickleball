export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === 'www.kortedoscdo.club') {
      url.hostname = 'kortedoscdo.club';
      return Response.redirect(url.toString(), 301);
    }

    // Cloudflare Pages resolves extensionless HTML routes through the asset
    // binding. Redirecting /host to /host.html here conflicts with Pages'
    // canonical /host.html -> /host redirect and creates a redirect loop.
    const response = await env.ASSETS.fetch(request);
    if ([
      "/host-balance-payment.js",
      "/host-balance-admin.js",
    ].includes(url.pathname)) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-cache, max-age=0, must-revalidate");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
};
