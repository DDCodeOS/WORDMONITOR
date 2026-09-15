import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '@/config';
import { initLiveChannelsWindow } from '@/live-channels-window';

import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/utils/user-location', () => ({ resolveUserCountryCode: async () => null }));

interface StoredChannels {
  order?: string[];
  custom?: Array<Record<string, unknown>>;
}

let fetchSpy: ReturnType<typeof vi.fn>;

function stored(): StoredChannels {
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.liveChannels) ?? '{}') as StoredChannels;
}

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return element;
}

async function add(fields: { source?: string; hls?: string; name?: string }): Promise<void> {
  input('liveChannelsHandle').value = fields.source ?? '';
  input('liveChannelsHlsUrl').value = fields.hls ?? '';
  input('liveChannelsName').value = fields.name ?? '';
  document.getElementById('liveChannelsAddBtn')?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function hint(): HTMLElement | null {
  return document.getElementById('liveChannelsHandleHint');
}

function requestedUrls(): string[] {
  return fetchSpy.mock.calls.map(([url]) => String(url));
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEYS.liveChannels, JSON.stringify({ order: ['bloomberg'], custom: [], displayNameOverrides: {} }));
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ channelName: 'DW News', title: 'DW News livestream' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  const container = document.createElement('div');
  document.body.appendChild(container);
  await initLiveChannelsWindow(container);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Live channels add form', () => {
  it('stores a pasted channel URL as a channel id, without resolving anything', async () => {
    await add({ source: 'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg', name: 'DW' });

    expect(stored().custom).toEqual([{ id: 'custom-uc-UCknLrEdhRCp1aegoMqRaCZg', name: 'DW', channelId: 'UCknLrEdhRCp1aegoMqRaCZg' }]);
    expect(stored().order).toEqual(['bloomberg', 'custom-uc-UCknLrEdhRCp1aegoMqRaCZg']);
    expect(requestedUrls()).toEqual([]);
  });

  it.each(['@CNN', 'https://www.youtube.com/@CNN', 'https://www.youtube.com/c/CNN', 'CNN'])(
    'asks for a channel or video URL instead of looking up %s',
    async (source) => {
      await add({ source });

      expect(hint()?.hidden).toBe(false);
      expect(hint()?.textContent).toBe('Paste a channel URL (youtube.com/channel/UC…) or a live video URL');
      expect(input('liveChannelsHandle').classList.contains('invalid')).toBe(true);
      expect(stored().custom).toEqual([]);
      expect(requestedUrls().some((url) => url.includes('/api/youtube/live?channel='))).toBe(false);
    },
  );

  it('stores a pasted video URL as a video id and names it from the video', async () => {
    await add({ source: 'https://www.youtube.com/watch?v=LuKwFajn37U' });

    expect(requestedUrls()).toEqual([expect.stringContaining('/api/youtube/live?videoId=LuKwFajn37U')]);
    expect(stored().custom).toEqual([{ id: 'custom-vid-LuKwFajn37U', name: 'DW News', videoId: 'LuKwFajn37U' }]);
    expect(hint()?.hidden).toBe(true);
  });

  it('keeps an edit open and explains an unusable source instead of dropping the change', async () => {
    await add({ source: 'https://www.youtube.com/watch?v=LuKwFajn37U' });
    document.querySelector<HTMLElement>('.live-news-manage-row[data-channel-id="custom-vid-LuKwFajn37U"] .live-news-manage-row-name')?.click();
    const source = document.querySelector<HTMLInputElement>('.live-news-manage-row-editing .live-news-manage-edit-handle');
    if (!source) throw new Error('edit form did not open');
    source.value = '@CNN';
    document.querySelector<HTMLButtonElement>('.live-news-manage-row-editing .live-news-manage-save')?.click();

    const editing = document.querySelector<HTMLElement>('.live-news-manage-row-editing');
    expect(editing).not.toBeNull();
    const editHint = editing?.querySelector<HTMLElement>('.live-news-manage-hint');
    expect(editHint?.hidden).toBe(false);
    expect(editHint?.textContent).toBe('Paste a channel URL (youtube.com/channel/UC…) or a live video URL');
    expect(source.classList.contains('invalid')).toBe(true);
    expect(stored().custom).toEqual([{ id: 'custom-vid-LuKwFajn37U', name: 'DW News', videoId: 'LuKwFajn37U' }]);
  });

  it('rejects an http:// stream URL', async () => {
    await add({ hls: 'http://tv.example/live.m3u8', name: 'Local TV' });

    expect(input('liveChannelsHlsUrl').classList.contains('invalid')).toBe(true);
    expect(stored().custom).toEqual([]);
  });

  it('stores an https:// stream URL', async () => {
    await add({ hls: 'https://tv.example/live.m3u8', name: 'Local TV' });

    const custom = stored().custom ?? [];
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ name: 'Local TV', hlsUrl: 'https://tv.example/live.m3u8' });
    expect(String(custom[0]?.id)).toMatch(/^custom-hls-/);
  });
});
