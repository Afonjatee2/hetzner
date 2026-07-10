import { createServer } from "node:http";
import { add } from "./math.js";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>Fixture</title><h1 data-testid="result">2 + 3 = ${add(2, 3)}</h1>`);
});
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");

