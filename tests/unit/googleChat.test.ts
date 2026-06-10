import { describe, it, expect, vi, afterEach } from 'vitest';
import { GoogleChatSender, classifyStatus } from '../../src/reporting/googleChat.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyStatus', () => {
  it('covers the full taxonomy', () => {
    expect(classifyStatus(204)).toBe('ok');
    expect(classifyStatus(429)).toBe('transient');
    expect(classifyStatus(500)).toBe('transient');
    expect(classifyStatus(401)).toBe('permanent');
    expect(classifyStatus(403)).toBe('permanent');
    expect(classifyStatus(404)).toBe('permanent');
    expect(classifyStatus(301)).toBe('transient');
  });
});

describe('GoogleChatSender.send', () => {
  it('POSTs the text payload and returns ok on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const sender = new GoogleChatSender('https://chat.example/webhook');
    expect(await sender.send('hello')).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chat.example/webhook',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'hello' }) }),
    );
  });

  it('maps a 403 to permanent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 403 }));
    expect(await new GoogleChatSender('https://x').send('y')).toBe('permanent');
  });

  it('treats a network error as transient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect(await new GoogleChatSender('https://x').send('y')).toBe('transient');
  });
});
