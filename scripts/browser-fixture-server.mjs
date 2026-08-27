import http from 'node:http';

const port = Number(process.env.PORT || 4173);
const crossOriginPort = Number(process.env.CROSS_ORIGIN_PORT || 4174);

function page(body) {
  return `<!doctype html>
<html>
  <head><title>Extension browser fixture</title></head>
  <body>${body}</body>
</html>`;
}

function responseFor(pathname) {
  if (pathname === '/initial') {
    return page('<video id="initial-video" src="/media/initial.mp4"></video>');
  }

  if (pathname === '/delayed') {
    return page(`<script>
      setTimeout(() => {
        const video = document.createElement('video')
        video.id = 'delayed-video'
        video.src = '/media/delayed.mp4'
        document.body.appendChild(video)
      }, 250)
    </script>`);
  }

  if (pathname === '/iframe') {
    return page(`<iframe id="same-origin-frame" src="/iframe-content"></iframe>
      <iframe id="cross-origin-frame" src="http://127.0.0.1:${crossOriginPort}/iframe-content"></iframe>`);
  }

  if (pathname === '/iframe-content') {
    return page(`<script>
      setTimeout(() => {
        const video = document.createElement('video')
        video.id = 'iframe-video'
        video.src = '/media/iframe.mp4'
        document.body.appendChild(video)
      }, 250)
    </script>`);
  }

  return page('<p>Unknown fixture</p>');
}

const server = http.createServer((request, response) => {
  const body = responseFor(new URL(request.url, `http://${request.headers.host}`).pathname);
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Browser fixture server listening on ${port}`);
});
