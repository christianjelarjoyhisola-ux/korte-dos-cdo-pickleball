export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === 'www.kortedoscdo.club') {
      url.hostname = 'kortedoscdo.club';
      return Response.redirect(url.toString(), 301);
    }

    return env.ASSETS.fetch(request);
  },
};
