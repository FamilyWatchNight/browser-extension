import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaptionFetchError, fetchCaptionPayload } from '../../shared/utils/caption-fetch';

describe('caption fetch diagnostics', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports request failures without including URL paths or query parameters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    let failure: unknown;
    try {
      await fetchCaptionPayload(
        'https://captions.example/private/session/subtitles?token=do-not-expose',
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CaptionFetchError);
    expect(failure).toMatchObject({
      category: 'network',
      diagnostics: {
        stage: 'request',
        endpoint: 'https://captions.example',
      },
    });
    expect(JSON.stringify(failure)).not.toContain('do-not-expose');
    expect(JSON.stringify(failure)).not.toContain('/private/session');
    if (failure instanceof Error) {
      expect(failure.message).not.toContain('do-not-expose');
    }
  });

  it('reports HTTP status and sanitized content type for error responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: {
          get: (name: string) => (name === 'content-type' ? 'text/html; charset=utf-8' : null),
        },
      }),
    );

    await expect(
      fetchCaptionPayload('https://captions.example/subtitles?token=private'),
    ).rejects.toMatchObject({
      category: 'auth',
      diagnostics: {
        stage: 'response',
        endpoint: 'https://captions.example',
        httpStatus: 403,
        contentType: 'text/html',
      },
    });
  });

  it('does not send page credentials with caption requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name === 'content-type' ? 'text/vtt' : null),
      },
      text: async () => 'WEBVTT',
      url: 'https://captions.example/subtitles.vtt',
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchCaptionPayload('https://captions.example/subtitles.vtt');

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://captions.example/subtitles.vtt'),
      expect.objectContaining({ credentials: 'omit' }),
    );
  });
});
