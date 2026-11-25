import { describe, expect, it } from "vitest";
import { build, loadConfigFromFile } from "vite";
import { resolve } from "node:path";

describe("NowcoderAdapter Service Worker compatibility", () => {
  it("浏览器产物在没有 document/window 的环境中可加载并创建 Markdown 草稿", async () => {
    const config = await loadConfigFromFile(
      { command: "build", mode: "production" },
      resolve(__dirname, "../vite.config.ts"),
    );
    if (!config) throw new Error("Vite config not found");

    const result = await build({
      configFile: false,
      logLevel: "silent",
      resolve: config.config.resolve,
      plugins: config.config.plugins?.filter(
        (plugin) =>
          plugin &&
          "name" in plugin &&
          plugin.name === "worker-markdown-entities",
      ),
      define: config.config.define,
      build: {
        write: false,
        minify: false,
        lib: {
          entry: resolve(
            __dirname,
            "../../core/src/adapters/platforms/nowcoder.ts",
          ),
          name: "NowcoderWorkerTest",
          formats: ["es"],
        },
      },
    });

    const output = Array.isArray(result) ? result[0] : result;
    if (!("output" in output)) throw new Error("Unexpected build output");
    const chunk = output.output.find((item) => item.type === "chunk");
    if (!chunk || chunk.type !== "chunk")
      throw new Error("Worker bundle not found");

    expect(typeof document).toBe("undefined");
    expect(typeof window).toBe("undefined");

    const bundleUrl = `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`;
    const { NowcoderAdapter } = await import(
      /* @vite-ignore */ bundleUrl
    ).catch((error) => {
      throw new Error(`浏览器构建产物加载失败：${error.message}`);
    });

    let savedBody: Record<string, unknown> | undefined;
    const adapter = new NowcoderAdapter();
    await adapter.init({
      type: "extension",
      fetch: async (url: string, options?: RequestInit) => {
        if (url.endsWith("/profile/user-info-v2")) {
          return Response.json({
            code: 0,
            data: { userId: 123, nickname: "测试用户", headImg: "" },
          });
        }
        if (url.endsWith("/api/sparta/discuss-draft/save")) {
          savedBody = JSON.parse(options?.body as string);
          return Response.json({ code: 0, data: 456 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    const markdown =
      "# 标题 & 公式\n\n$x^2$\n\n```typescript\nconst ok = true\n```";
    await expect(
      adapter.publish({ title: "测试", markdown }),
    ).resolves.toMatchObject({
      success: true,
      draftOnly: true,
      postId: "456",
      postUrl: "https://www.nowcoder.com/creation/write/md?draftId=456",
    });
    expect(savedBody?.mdContent).toBe(markdown);
    expect(savedBody?.content).toContain('<code class="language-typescript">');
  }, 20000);
});
