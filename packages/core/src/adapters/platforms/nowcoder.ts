/**
 * 牛客网适配器
 * https://www.nowcoder.com
 *
 * 牛客的 Markdown 编辑器会同时保存 Markdown 源文和渲染后的 HTML，
 * 草稿接口位于 gw-c.nowcoder.com，登录态复用 nowcoder.com Cookie。
 */
import { CodeAdapter, type ImageUploadResult } from "../code-adapter";
import type {
  Article,
  AuthResult,
  SyncResult,
  PlatformMeta,
} from "../../types";
import type { PublishOptions } from "../types";
import { markdownToHtml } from "../../lib/turndown";

interface NowcoderResponse<T> {
  code: number;
  msg?: string;
  message?: string;
  data: T;
  url?: string;
}

interface NowcoderUser {
  userId: number | string;
  nickname?: string;
  headImg?: string;
}

interface NowcoderImageData {
  url?: string;
}

const WWW_ORIGIN = "https://www.nowcoder.com";
const GATEWAY_ORIGIN = "https://gw-c.nowcoder.com";
const WRITE_URL = `${WWW_ORIGIN}/creation/write/md`;
const USER_INFO_URL = `${WWW_ORIGIN}/profile/user-info-v2`;
const SAVE_DRAFT_URL = `${GATEWAY_ORIGIN}/api/sparta/discuss-draft/save`;
const UPLOAD_IMAGE_URL = `${WWW_ORIGIN}/uploadImage?type=1`;
const TRANSFER_IMAGE_URL = `${WWW_ORIGIN}/nccommon/upload-image-online?watermark=true`;

export class NowcoderAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: "nowcoder",
    name: "牛客",
    icon: "https://www.nowcoder.com/favicon.ico",
    homepage: `${WWW_ORIGIN}/creation/manager/content?type=draft`,
    capabilities: ["article", "draft", "image_upload"],
  };

  readonly preprocessConfig = {
    outputFormat: "markdown" as const,
  };

  private readonly HEADER_RULES = [
    {
      urlFilter: "*://www.nowcoder.com/*",
      headers: {
        Origin: WWW_ORIGIN,
        Referer: WRITE_URL,
      },
      resourceTypes: ["xmlhttprequest"],
    },
    {
      urlFilter: "*://gw-c.nowcoder.com/*",
      headers: {
        Origin: WWW_ORIGIN,
        Referer: WRITE_URL,
      },
      resourceTypes: ["xmlhttprequest"],
    },
  ];

  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const response =
          await this.requestJson<NowcoderResponse<NowcoderUser | null>>(
            USER_INFO_URL,
          );
        if (response.code !== 0 || !response.data?.userId) {
          return {
            isAuthenticated: false,
            error: response.msg || response.message || "未登录",
          };
        }

        return {
          isAuthenticated: true,
          userId: String(response.data.userId),
          username: response.data.nickname || String(response.data.userId),
          avatar: response.data.headImg,
        };
      });
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message };
    }
  }

  async publish(
    article: Article,
    options?: PublishOptions,
  ): Promise<SyncResult> {
    const now = Date.now();

    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const authResponse =
          await this.requestJson<NowcoderResponse<NowcoderUser | null>>(
            USER_INFO_URL,
          );
        const user = authResponse.data;
        if (authResponse.code !== 0 || !user?.userId) {
          throw new Error(
            authResponse.msg || authResponse.message || "牛客登录状态已失效",
          );
        }

        const sourceMarkdown = article.markdown || "";
        const title = article.title.trim();
        if (!title) {
          throw new Error("文章标题为空");
        }
        if (title.length > 50) {
          throw new Error(
            `牛客文章标题最多 50 个字符，当前为 ${title.length} 个字符`,
          );
        }
        if (!sourceMarkdown.trim()) {
          throw new Error("文章 Markdown 正文为空");
        }

        const markdown = await this.processImages(
          sourceMarkdown,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ["uploadfiles.nowcoder.com", "static.nowcoder.com"],
            onProgress: options?.onImageProgress,
            throwOnError: true,
          },
        );
        const html = markdownToHtml(markdown);

        const draftPayload: Record<string, unknown> = {
          mdContent: markdown,
          content: html,
          title,
          authorId: user.userId,
          id: null,
          entityType: 250,
          distinctPost: false,
          jsonContent: "",
          isAcm: false,
          subjectIds: [],
          zhuanlanIdStr: "",
          askQuestion: false,
          reward: "",
          tags: [],
          questionId: null,
          questionTitle: null,
          questionUrl: null,
          blogTags: [],
          publishEntrance_var: "写文章",
          publishEntrancePage_var: "创作中心",
        };

        const response = await this.requestJson<
          NowcoderResponse<string | number | null>
        >(SAVE_DRAFT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            Accept: "application/json, text/plain, */*",
          },
          body: JSON.stringify(draftPayload),
        });

        if (response.code !== 0) {
          throw new Error(
            response.msg || response.message || "牛客草稿保存失败",
          );
        }

        const draftId = response.data;
        if (
          draftId === undefined ||
          draftId === null ||
          String(draftId) === ""
        ) {
          throw new Error("牛客草稿保存成功但未返回草稿 ID");
        }

        return {
          platform: this.meta.id,
          success: true,
          postId: String(draftId),
          postUrl: `${WRITE_URL}?draftId=${encodeURIComponent(String(draftId))}`,
          draftOnly: true,
          timestamp: now,
        };
      });
    } catch (error) {
      return {
        platform: this.meta.id,
        success: false,
        error: (error as Error).message,
        timestamp: now,
      };
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (
      src.startsWith("https://uploadfiles.nowcoder.com/") ||
      src.startsWith("//uploadfiles.nowcoder.com/")
    ) {
      return { url: this.normalizeUrl(src) };
    }

    if (/^https?:\/\//i.test(src) || src.startsWith("//")) {
      const source = this.normalizeUrl(src);
      try {
        return { url: await this.transferRemoteImage(source) };
      } catch (transferError) {
        try {
          return { url: await this.downloadAndUploadImage(source) };
        } catch (uploadError) {
          throw new Error(
            `牛客在线转存失败：${(transferError as Error).message}；` +
              `下载后上传仍失败：${(uploadError as Error).message}`,
          );
        }
      }
    }

    return { url: await this.downloadAndUploadImage(src) };
  }

  private async transferRemoteImage(source: string): Promise<string> {
    const formData = new FormData();
    formData.append("type", "0");
    formData.append("source", source);
    const response = await this.requestJson<
      NowcoderResponse<NowcoderImageData | string | null>
    >(TRANSFER_IMAGE_URL, {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/plain, */*",
      },
      body: formData,
    });
    return this.extractImageUrl(response);
  }

  private async downloadAndUploadImage(source: string): Promise<string> {
    const imageResponse = await this.runtime.fetch(source);
    if (!imageResponse.ok) {
      throw new Error(`下载图片失败: HTTP ${imageResponse.status}`);
    }
    const blob = await imageResponse.blob();
    if (!blob.size) {
      throw new Error("下载图片失败: 图片内容为空");
    }

    const extension = this.extensionForMime(blob.type);
    const formData = new FormData();
    formData.append("file", blob, `wechatsync-${Date.now()}.${extension}`);

    const response = await this.requestJson<
      NowcoderResponse<NowcoderImageData | string | null>
    >(UPLOAD_IMAGE_URL, {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/plain, */*",
      },
      body: formData,
    });
    return this.extractImageUrl(response);
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.runtime.fetch(url, {
      credentials: "include",
      ...init,
      headers: {
        Accept: "application/json, text/plain, */*",
        ...(init.headers || {}),
      },
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `牛客请求失败: HTTP ${response.status}${text ? ` - ${text.slice(0, 200)}` : ""}`,
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`牛客响应不是有效 JSON: ${text.slice(0, 200)}`);
    }
  }

  private extractImageUrl(
    response: NowcoderResponse<NowcoderImageData | string | null>,
  ): string {
    if (response.code !== 0) {
      throw new Error(response.msg || response.message || "牛客图片上传失败");
    }

    const dataUrl =
      typeof response.data === "string" ? response.data : response.data?.url;
    const url = response.url || dataUrl;
    if (!url) {
      throw new Error("牛客图片上传成功但未返回图片 URL");
    }
    return this.normalizeUrl(url);
  }

  private normalizeUrl(url: string): string {
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("/")) return `${WWW_ORIGIN}${url}`;
    return url;
  }

  private extensionForMime(mime: string): string {
    const subtype = mime.split("/")[1]?.toLowerCase();
    if (!subtype) return "png";
    if (subtype === "jpeg") return "jpg";
    return subtype.replace(/[^a-z0-9]/g, "") || "png";
  }
}
