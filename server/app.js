import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { environment } from "./config/environment.js";
import { getDatabase } from "./db/database.js";
import { createCompany, getCompany, listCompanies } from "./routes/companies.js";

const maximumRequestBytes = 100_000;
const staticMimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maximumRequestBytes) {
        reject(new Error("요청 본문이 너무 큽니다."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON 형식이 올바르지 않습니다."));
      }
    });
    request.on("error", reject);
  });
}

function serveStaticFile(pathname, response) {
  const requestedFile = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = path.resolve(environment.projectDirectory, requestedFile);

  // URL 조작으로 프로젝트 폴더 밖의 파일을 읽지 못하게 한다.
  if (!safePath.startsWith(`${environment.projectDirectory}${path.sep}`) && safePath !== path.join(environment.projectDirectory, "index.html")) {
    sendJson(response, 403, { error: "허용되지 않은 경로입니다." });
    return;
  }

  if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
    sendJson(response, 404, { error: "요청한 화면을 찾을 수 없습니다." });
    return;
  }

  response.writeHead(200, { "Content-Type": staticMimeTypes[path.extname(safePath)] ?? "application/octet-stream" });
  fs.createReadStream(safePath).pipe(response);
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const { pathname } = requestUrl;

  try {
    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, {
        status: "ok",
        database: "connected",
        apiKeyConfigured: Boolean(environment.marketDataApiKey)
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/companies") {
      sendJson(response, 200, { companies: listCompanies() });
      return;
    }

    const companyMatch = pathname.match(/^\/api\/companies\/([^/]+)$/);
    if (request.method === "GET" && companyMatch) {
      const result = getCompany(decodeURIComponent(companyMatch[1]));
      sendJson(response, result.statusCode ?? 200, result.error ? { error: result.error } : result);
      return;
    }

    if (request.method === "POST" && pathname === "/api/companies") {
      const result = createCompany(await readJsonBody(request));
      sendJson(response, result.statusCode ?? 201, result.error ? { error: result.error } : result);
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "존재하지 않는 API 경로입니다." });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "지원하지 않는 요청 방식입니다." });
      return;
    }

    serveStaticFile(pathname, response);
  } catch (error) {
    console.error("요청 처리 실패:", error.message);
    sendJson(response, 500, { error: "서버 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
  }
}

// 서버 시작 시 DB와 스키마를 미리 확인해 첫 요청에서 실패하지 않도록 한다.
getDatabase();

const server = http.createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(environment.port, () => {
  console.log(`US Stock Pro 서버 실행: http://localhost:${environment.port}`);
});
