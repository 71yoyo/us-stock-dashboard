import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(currentDirectory, "../..");

/**
 * 로컬 .env는 개발 편의를 위한 파일이다. 운영 환경에서는 호스팅 서비스의 환경 변수를 우선 사용한다.
 * 별도 패키지 없이 단순한 KEY=VALUE 형식만 읽어 API 키가 소스 코드에 섞이지 않도록 한다.
 */
function loadLocalEnvironmentFile() {
  const environmentPath = path.join(projectDirectory, ".env");

  if (!fs.existsSync(environmentPath)) {
    return;
  }

  const lines = fs.readFileSync(environmentPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    const separatorIndex = trimmedLine.indexOf("=");

    if (!trimmedLine || trimmedLine.startsWith("#") || separatorIndex < 1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");

    // 호스팅 환경에서 전달한 값은 로컬 파일보다 우선한다.
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadLocalEnvironmentFile();

const requestedPort = Number.parseInt(process.env.PORT ?? "3000", 10);

export const environment = {
  projectDirectory,
  port: Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 3000,
  databasePath: path.resolve(projectDirectory, process.env.DATABASE_PATH ?? "./data/us-stock-pro.sqlite"),
  marketDataApiKey: process.env.MARKET_DATA_API_KEY ?? ""
};
