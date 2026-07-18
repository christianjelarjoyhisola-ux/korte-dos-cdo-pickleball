export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === 'www.kortedoscdo.club') {
      url.hostname = 'kortedoscdo.club';
      return Response.redirect(url.toString(), 301);
    }

    // Cloudflare Pages resolves extensionless HTML routes through the asset
    // binding. Redirecting /host to /host.html here conflicts with Pages'
    // canonical /host.html -> /host redirect and creates a redirect loop.
    return env.ASSETS.fetch(request);
  },
};
