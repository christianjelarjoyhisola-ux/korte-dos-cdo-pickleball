export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === 'www.kortedoscdo.club') {
      url.hostname = 'kortedoscdo.club';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/host') {
      url.pathname = '/host.html';
      return Response.redirect(url.toString(), 302);
    }

    return env.ASSETS.fetch(request);
  },
};
