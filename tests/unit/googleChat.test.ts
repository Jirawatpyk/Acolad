import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GoogleChatSender,
  classifyStatus,
  isPayloadRejection,
} from '../../src/reporting/googleChat.js';

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

  it('classifies 400 as permanent', () => {
    expect(classifyStatus(400)).toBe('permanent');
  });
});

describe('isPayloadRejection', () => {
  it('returns true only for 400', () => {
    expect(isPayloadRejection(400)).toBe(true);
    expect(isPayloadRejection(401)).toBe(false);
    expect(isPayloadRejection(403)).toBe(false);
    expect(isPayloadRejection(404)).toBe(false);
    expect(isPayloadRejection(500)).toBe(false);
    expect(isPayloadRejection(200)).toBe(false);
  });
});

describe('GoogleChatSender.send (ChatPayload union)', () => {
  it('POSTs a {text} payload verbatim and returns ok on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const sender = new GoogleChatSender('https://chat.example/webhook');
    expect(await sender.send({ text: 'hello' })).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chat.example/webhook',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'hello' }) }),
    );
  });

  it('POSTs a {cardsV2} payload verbatim and returns ok on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const sender = new GoogleChatSender('https://chat.example/webhook');
    const card = { cardId: 'c', card: {} };
    expect(await sender.send({ cardsV2: [card] })).toBe('ok');
    const reqInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse((reqInit?.body as string | undefined) ?? '') as unknown;
    expect(body).toEqual({ cardsV2: [card] });
  });

  it('maps a 403 to permanent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 403 }));
    expect(await new GoogleChatSender('https://x').send({ text: 'y' })).toBe('permanent');
  });

  it('maps a 400 to permanent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 400 }));
    expect(await new GoogleChatSender('https://x').send({ text: 'y' })).toBe('permanent');
  });

  it('treats a network error as transient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect(await new GoogleChatSender('https://x').send({ text: 'y' })).toBe('transient');
  });
});

describe('GoogleChatSender.sendDetailed', () => {
  it('returns {outcome, status} on a successful POST', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    const result = await new GoogleChatSender('https://x').sendDetailed({ text: 'hi' });
    expect(result).toEqual({ outcome: 'ok', status: 200 });
  });

  it('returns {outcome: permanent, status: 400} on 400', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 400 }));
    const result = await new GoogleChatSender('https://x').sendDetailed({ text: 'hi' });
    expect(result).toEqual({ outcome: 'permanent', status: 400 });
  });

  it('returns {outcome: transient, status: 0} on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const result = await new GoogleChatSender('https://x').sendDetailed({ text: 'hi' });
    expect(result).toEqual({ outcome: 'transient', status: 0 });
  });
});
