import { beforeEach, describe, expect, it, vi } from "vitest";
import { NowcoderAdapter } from "../nowcoder";
import type { RuntimeInterface } from "../../../runtime/interface";
import type { Article, HeaderRule } from "../../../types";

const article: Article = {
  title: "牛客同步验证",
  markdown: '# 标题\n\n正文\n\n```typescript\nconsole.log("ok")\n```',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function createRuntime() {
  let nextDraftId = 1000;
  const fetch = vi.fn(
    async (url: string, options?: RequestInit): Promise<Response> => {
      if (url.endsWith("/profile/user-info-v2")) {
        return json({
          code: 0,
          msg: "",
          data: {
            userId: 123456,
            nickname: "牛客测试用户",
            headImg: "https://example.com/avatar.png",
          },
        });
      }
      if (url.includes("/upload-image-online")) {
        return json({
          code: 0,
          data: null,
          url: "https://uploadfiles.nowcoder.com/images/synced.png",
        });
      }
      if (url.includes("/uploadImage?type=1")) {
        return json({
          code: 0,
          data: null,
          url: "https://uploadfiles.nowcoder.com/images/local.png",
        });
      }
      if (url.includes("/api/sparta/discuss-draft/save")) {
        return json({ code: 0, msg: "", data: nextDraftId++ });
      }
      if (url.startsWith("data:")) return globalThis.fetch(url);
      throw new Error(
        `Unexpected test request: ${url} ${options?.method || "GET"}`,
      );
    },
  );
  let nextRuleId = 0;
  const headerRules = {
    add: vi.fn(async (_rule: HeaderRule) => `rule-${nextRuleId++}`),
    remove: vi.fn(async (_id: string) => {}),
    clear: vi.fn(async () => {}),
  };
  const runtime = {
    type: "extension",
    fetch,
    headerRules,
  } as unknown as RuntimeInterface;
  return { runtime, fetch, headerRules };
}

describe("NowcoderAdapter", () => {
  let adapter: NowcoderAdapter;
  let port: ReturnType<typeof createRuntime>;

  beforeEach(async () => {
    adapter = new NowcoderAdapter();
    port = createRuntime();
    await adapter.init(port.runtime);
  });

  it("声明牛客平台元信息和 Markdown 预处理能力", () => {
    expect(adapter.meta).toMatchObject({
      id: "nowcoder",
      name: "牛客",
      capabilities: ["article", "draft", "image_upload"],
    });
    expect(adapter.preprocessConfig).toEqual({ outputFormat: "markdown" });
  });

  it("读取牛客用户身份并清理 Header 规则", async () => {
    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: true,
      userId: "123456",
      username: "牛客测试用户",
      avatar: "https://example.com/avatar.png",
    });
    expect(port.headerRules.add).toHaveBeenCalledTimes(2);
    expect(port.headerRules.remove).toHaveBeenCalledTimes(2);
  });

  it("未登录时不创建草稿", async () => {
    port.fetch.mockImplementation(async () =>
      json({ code: 999, msg: "用户未登录", data: null }),
    );
    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: false,
      error: "用户未登录",
    });
    const result = await adapter.publish(article);
    expect(result).toMatchObject({ success: false, error: "用户未登录" });
    expect(
      port.fetch.mock.calls.some(([url]) => url.includes("discuss-draft/save")),
    ).toBe(false);
  });

  it("创建全新 Markdown 草稿并返回牛客编辑链接", async () => {
    const first = await adapter.publish(article);
    const second = await adapter.publish(article);

    expect(first).toMatchObject({
      platform: "nowcoder",
      success: true,
      draftOnly: true,
      postId: "1000",
      postUrl: "https://www.nowcoder.com/creation/write/md?draftId=1000",
    });
    expect(second.postId).toBe("1001");

    const saves = port.fetch.mock.calls.filter(([url]) =>
      url.includes("discuss-draft/save"),
    );
    expect(saves).toHaveLength(2);
    const payload = JSON.parse(saves[0][1]!.body as string);
    expect(payload).toMatchObject({
      title: article.title,
      mdContent: article.markdown,
      authorId: 123456,
      id: null,
      entityType: 250,
      distinctPost: false,
      jsonContent: "",
      isAcm: false,
      subjectIds: [],
      zhuanlanIdStr: "",
      askQuestion: false,
      tags: [],
      blogTags: [],
      publishEntrance_var: "写文章",
      publishEntrancePage_var: "创作中心",
    });
    expect(payload.content).toContain("<h1>标题</h1>");
    expect(payload.content).toContain('<code class="language-typescript">');
  });

  it("标题超过牛客 50 字符限制时不保存草稿", async () => {
    const result = await adapter.publish({
      ...article,
      title: "长".repeat(51),
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("最多 50 个字符"),
    });
    expect(
      port.fetch.mock.calls.some(([url]) => url.includes("discuss-draft/save")),
    ).toBe(false);
  });

  it("转存外链图片并同步更新 Markdown 与 HTML", async () => {
    const progress = vi.fn();
    const result = await adapter.publish(
      { ...article, markdown: "![图](https://example.com/source.png)" },
      { onImageProgress: progress },
    );
    expect(result.success).toBe(true);

    const transfer = port.fetch.mock.calls.find(([url]) =>
      url.includes("/upload-image-online"),
    )!;
    expect(transfer[0]).toBe(
      "https://www.nowcoder.com/nccommon/upload-image-online?watermark=true",
    );
    expect(transfer[1]).toMatchObject({
      method: "POST",
      credentials: "include",
    });
    expect(transfer[1]!.body).toBeInstanceOf(FormData);
    const transferBody = transfer[1]!.body as FormData;
    expect(transferBody.get("source")).toBe("https://example.com/source.png");
    expect(transferBody.get("type")).toBe("0");

    const save = port.fetch.mock.calls.find(([url]) =>
      url.includes("discuss-draft/save"),
    )!;
    const payload = JSON.parse(save[1]!.body as string);
    expect(payload.mdContent).toBe(
      "![图](https://uploadfiles.nowcoder.com/images/synced.png)",
    );
    expect(payload.content).toContain(
      "https://uploadfiles.nowcoder.com/images/synced.png",
    );
    expect(progress).toHaveBeenCalledWith(1, 1);
  });

  it("在线转存失败时下载外链图片并通过 multipart 上传", async () => {
    const normalFetch = port.fetch.getMockImplementation()!;
    port.fetch.mockImplementation(async (url, options) => {
      if (url.includes("/nccommon/upload-image-online")) {
        return json({ code: 1, msg: "在线转存失败", data: null });
      }
      if (url === "https://example.com/fallback.png") {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        });
      }
      return normalFetch(url, options);
    });

    const result = await adapter.publish({
      ...article,
      markdown: "![图](https://example.com/fallback.png)",
    });
    expect(result.success).toBe(true);
    expect(
      port.fetch.mock.calls.some(([url]) =>
        url.includes("/uploadImage?type=1"),
      ),
    ).toBe(true);
  });

  it("在线转存与下载上传均失败时阻止草稿保存", async () => {
    const normalFetch = port.fetch.getMockImplementation()!;
    port.fetch.mockImplementation(async (url, options) => {
      if (url.includes("/nccommon/upload-image-online")) {
        return json({ code: 1, msg: "在线转存失败", data: null });
      }
      if (url === "https://example.com/broken.png") {
        return new Response("upstream error", { status: 502 });
      }
      return normalFetch(url, options);
    });

    const result = await adapter.publish({
      ...article,
      markdown: "![坏图](https://example.com/broken.png)",
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("图片上传失败"),
    });
    expect(
      port.fetch.mock.calls.some(([url]) => url.includes("discuss-draft/save")),
    ).toBe(false);
  });

  it("上传 data URI 图片为 multipart 文件", async () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgo=";
    const result = await adapter.publish({
      ...article,
      markdown: `![图](${dataUri})`,
    });
    expect(result.success).toBe(true);

    const upload = port.fetch.mock.calls.find(([url]) =>
      url.includes("/uploadImage?type=1"),
    )!;
    expect(upload[1]?.method).toBe("POST");
    expect(upload[1]?.body).toBeInstanceOf(FormData);
    const save = port.fetch.mock.calls.find(([url]) =>
      url.includes("discuss-draft/save"),
    )!;
    expect(JSON.parse(save[1]!.body as string).mdContent).toContain(
      "https://uploadfiles.nowcoder.com/images/local.png",
    );
  });

  it.each([
    { code: 1, msg: "草稿保存失败", data: null },
    { code: 0, msg: "", data: null },
    { code: 0, msg: "", data: "" },
  ])("不把异常草稿响应报告为成功 %#", async (body) => {
    const normalFetch = port.fetch.getMockImplementation()!;
    port.fetch.mockImplementation((url, options) =>
      url.includes("/api/sparta/discuss-draft/save")
        ? Promise.resolve(json(body))
        : normalFetch(url, options),
    );
    const result = await adapter.publish(article);
    expect(result.success).toBe(false);
    expect(result.error).toContain("草稿");
  });

  it("服务端返回非 JSON 时给出可定位错误", async () => {
    port.fetch.mockResolvedValue(new Response("<html>login</html>"));
    await expect(adapter.checkAuth()).resolves.toMatchObject({
      isAuthenticated: false,
      error: expect.stringContaining("有效 JSON"),
    });
  });
});
