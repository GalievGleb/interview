import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HH_NEGOTIATIONS_URL,
  isOutgoingChatClassName,
} from './hhChatBrowser';

const source = fs.readFileSync(path.resolve(__dirname, 'hhChatBrowser.ts'), 'utf8');

describe('HhChatBrowser current HH contract', () => {
  it('uses the current applicant negotiations route', () => {
    expect(HH_NEGOTIATIONS_URL).toBe('https://hh.ru/applicant/negotiations');
    expect(source).not.toContain("https://hh.ru/negotiations'");
  });

  it('uses the current list, Chatik frame, input, and send selectors', () => {
    expect(source).toContain('[data-qa="negotiations-item"]');
    expect(source).toContain('[data-qa="open_chat"]');
    expect(source).toContain("chatik.hh.ru/chat/");
    expect(source).toContain('[data-qa="chatik-new-message-text"]');
    expect(source).toContain('[data-qa="chatik-do-send-message"]');
  });

  it('recognizes the outgoing classes currently rendered by Chatik', () => {
    expect(isOutgoingChatClassName('message_my abc')).toBe(true);
    expect(isOutgoingChatClassName('chat-bubble_outgoing')).toBe(true);
    expect(isOutgoingChatClassName('chat-bubble_incoming')).toBe(false);
  });

  it('examines only the newest message and never replies after an applicant message', () => {
    expect(source).toContain('return messages.at(-1) ?? null');
    expect(source).toContain('if (!lastMessage || lastMessage.isMine) continue');
  });

  it('counts a reply only after HH renders a new matching outgoing message', () => {
    const sendAt = source.indexOf('private async sendChatMessage');
    const pollAt = source.indexOf('private async pollOnce');
    const pollSource = source.slice(pollAt, sendAt);
    const sendCallAt = pollSource.indexOf('await this.sendChatMessage(frame, reply)');
    const replyCountAt = pollSource.indexOf('this.repliesToday += 1');
    const sendSource = source.slice(sendAt);
    expect(sendSource).toContain('!beforeIds.has(item.id)');
    expect(sendSource).toContain('HH не подтвердил отправку ответа работодателю');
    expect(sendCallAt).toBeGreaterThan(-1);
    expect(replyCountAt).toBeGreaterThan(sendCallAt);
  });
});
