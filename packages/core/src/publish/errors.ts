import type { Platform } from '../types';
export type ErrorStage = 'config' | 'render' | 'image' | 'preflight' | 'push' | 'auth';
/** architecture.md 第 10 节的错误模型；message 与 action 给人看，不含凭证。 */
export interface JinzhangError {
  code: string;
  stage: ErrorStage;
  platform?: Platform;
  message: string;
  action?: string;
  ref?: string;
}
export class PublishError extends Error {
  constructor(readonly detail: JinzhangError) {
    super(detail.message);
    this.name = 'PublishError';
  }
}
export const fail = (detail: JinzhangError) => new PublishError(detail);
/** 未预期的异常统一包成 JinzhangError，只取消息，不带响应原文。 */
export function toJinzhangError(
  error: unknown,
  fallback: Omit<JinzhangError, 'message'> & { message?: string },
): JinzhangError {
  if (error instanceof PublishError) return error.detail;
  return {
    ...fallback,
    message: fallback.message ?? (error instanceof Error ? error.message : '未知错误'),
  };
}
