/**
 * 认证与 cookie 管理。
 *
 * 现状教训（2026-11-23）：115 的 `acw_tc` 会过期，过期后所有文件接口返回
 * `errno 990001 / 登录超时`，而账号信息接口仍能返回 —— 极易误判为"还在线"。
 * 因此本模块提供 `healthCheck()`，同时探测「账号接口 + 文件接口」，
 * 只要文件接口不通，就判定会话失效并要求重新扫码。
 */

import { P115Client } from "./client";

export interface AuthState {
  /** 是否有 cookie */
  hasCookie: boolean;
  /** 文件接口是否可用（账号接口可用但文件接口不可用 = 会话半失效） */
  fileApiOk: boolean;
  /** 账号接口返回的用户名 */
  userName?: string;
  /** 失败原因 */
  reason?: string;
}

export class AuthManager {
  private cookie = "";
  private client: P115Client | null = null;

  constructor(private readonly readCookie: () => string, private readonly writeCookie: (c: string) => void) {}

  /** 从持久化存储恢复 cookie（插件启动时调用） */
  load(): void {
    this.cookie = this.readCookie() ?? "";
    this.client = null;
  }

  getCookie(): string {
    return this.cookie;
  }

  hasCookie(): boolean {
    return this.cookie.trim().length > 0;
  }

  /** 保存扫码/手工粘贴得到的 cookie */
  setCookie(cookie: string): void {
    this.cookie = cookie.trim();
    this.writeCookie(this.cookie);
    this.client = null;
  }

  clear(): void {
    this.cookie = "";
    this.writeCookie("");
    this.client = null;
  }

  /** 供 client 使用的 cookie 提供者 */
  cookieProvider(): () => string {
    return () => this.cookie;
  }

  getClient(): P115Client {
    if (!this.client) {
      this.client = new P115Client({ getCookie: this.cookieProvider() });
    }
    return this.client;
  }

  /**
   * 会话健康检查：账号接口 + 文件接口同时探测。
   * 只有两者都通，才认为会话有效。
   */
  async healthCheck(): Promise<AuthState> {
    if (!this.hasCookie()) {
      return { hasCookie: false, fileApiOk: false, reason: "未配置 Cookie" };
    }
    const client = this.getClient();
    let userName: string | undefined;
    try {
      const acc = await client.account();
      userName = acc.user_name || undefined;
    } catch (err) {
      return { hasCookie: true, fileApiOk: false, reason: `账号接口失败：${(err as Error).message}` };
    }
    try {
      await client.listDir(client.rootCid, 0, 1);
      return { hasCookie: true, fileApiOk: true, userName };
    } catch (err) {
      return {
        hasCookie: true,
        fileApiOk: false,
        userName,
        reason: `文件接口失败（多为 acw_tc / 会话过期）：${(err as Error).message}`,
      };
    }
  }
}
