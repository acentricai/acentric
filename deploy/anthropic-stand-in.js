// A stand-in for Anthropic's API, for the recipes' tests: it takes any key when one is checked,
// so a model account can be added, and answers nothing else. It runs in the server's container,
// whose ACENTRIC_ANTHROPIC_API_URL is http://127.0.0.1:9998.
require('node:http')
  .createServer((request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[],"has_more":false}');
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"type":"error","error":{"type":"not_found_error","message":"a stand-in"}}');
  })
  .listen(9998, '127.0.0.1');
