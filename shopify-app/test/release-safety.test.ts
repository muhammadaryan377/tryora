import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("database-independent application startup", () => {
  it("keeps setup and the entire Docker start script chain free of database operations", () => {
    const { scripts } = JSON.parse(read("../package.json"));
    expect(scripts.setup).toBe("prisma generate");
    expect(scripts["docker-start"]).toBe("npm run start");
    expect(scripts.start).toBe("react-router-serve ./build/server/index.js");
    expect(Object.keys(scripts).filter((name) => /^(?:pre|post)(?:setup|start|docker-start|build)$/.test(name))).toEqual([]);
  });

  it("generates Prisma Client during the Docker build and only starts the app at runtime", () => {
    const dockerfile = read("../Dockerfile");
    expect(dockerfile).toContain("RUN npm run setup && npm run build");
    expect(dockerfile).toContain('CMD ["npm", "run", "docker-start"]');
    expect(dockerfile).not.toMatch(/prisma\s+(?:db|migrate)|--accept-data-loss/);
  });

  it("does not apply a migration to the development database just by starting Shopify CLI", () => {
    const config = read("../shopify.web.toml");
    expect(config).toContain('predev = "npx prisma generate"');
    expect(config).toContain('dev = "npm exec react-router dev"');
    expect(config).not.toMatch(/prisma\s+(?:db|migrate)/);
  });
});
