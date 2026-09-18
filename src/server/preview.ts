import type { MessageKey } from '../shared/protocol.ts';

const MAX_SOURCE_LENGTH = 4096;
export const MAX_PREVIEW_LENGTH = 120;
const MAX_SESSION_TITLE_LENGTH = 64;

export interface NotificationPreview {
  key: MessageKey;
  summary: string;
}

function boundedText(value: string, max: number, markdown: boolean): string {
  let text = value.slice(0, MAX_SOURCE_LENGTH).replace(/[\ud800-\udfff]/gu, '\ufffd');
  if (markdown) {
    text = text
      .replace(/^[ \t]*(`{3,}|~{3,})[^\r\n]*$/gm, '')
      .replace(/!?\[([^\]\r\n]*)\]\([^)\r\n]*\)/g, '$1')
      .replace(/^[ \t]*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, '')
      .replace(/(\*\*|__|~~|`+)/g, '');
  }
  text = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/gu, ' ').trim();
  if (!text) return '';
  const characters = Array.from(text);
  return characters.length > max || value.length > MAX_SOURCE_LENGTH ?
    `${characters.slice(0, max - 1).join('').trimEnd()}…` : text;
}

export function notificationExcerpt(content: string): string {
  return boundedText(content, MAX_PREVIEW_LENGTH, true);
}

export function sessionTitle(title: string): string {
  return boundedText(title, MAX_SESSION_TITLE_LENGTH, false);
}

export function notificationTitle(key: MessageKey, title?: string): string {
  const name = title || `会话 ${sessionTitle(key.sessionId.slice(0, 8))}`;
  return `${key.kind === 'reply' ? '新回复' : '待回答'}：${name}`;
}
