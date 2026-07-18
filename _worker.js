export default {
  fetch(request, env) {
    const url = new URL(request.url);

    // Set CANONICAL_HOST in Cloudflare when a custom domain is connected.
    const canonicalHost = env.CANONICAL_HOST;
    if (canonicalHost && url.hostname === `www.${canonicalHost}`) {
      url.hostname = canonicalHost;
      return Response.redirect(url.toString(), 301);
    }

    // Cloudflare Pages resolves extensionless HTML routes through the asset
    // binding. Redirecting /host to /host.html here conflicts with Pages'
    // canonical /host.html -> /host redirect and creates a redirect loop.
    return env.ASSETS.fetch(request);
  },
};
