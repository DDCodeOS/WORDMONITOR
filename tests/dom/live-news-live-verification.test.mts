import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveNewsPanel } from '@/components/LiveNewsPanel';
import { STORAGE_KEYS } from '@/config';
import { getActiveLiveMedia } from '@/services/live-media-controller';
import { LIVE_VIDEO_TIMING } from '@/services/live-video/model';

import { createFakeYouTubeIframeApi, type FakeYouTubeIframeApi } from './helpers/fake-youtube-iframe-api.mts';
import { initTestI18n } from './helpers/i18n.mts';

interface FakeHlsInstance {
  url: string;
  destroyed: boolean;
  emit(event: string, data: unknown): void;
}

const loader = vi.hoisted(() => ({ api: null as FakeYouTubeIframeApi | null, blocked: false }));
const hlsState = vi.hoisted(() => ({ instances: [] as FakeHlsInstance[] }));
const catalog = vi.hoisted(() => ({
  news: {} as Record<string, readonly string[]>,
  original: {} as Record<string, readonly string[]>,
}));

vi.mock('@/services/live-video/youtube-iframe-api', () => ({
  loadYouTubeIframeApi: () => Promise.resolve(loader.blocked ? null : loader.api?.namespace ?? null),
}));

vi.mock('hls.js', () => {
  class FakeHls {
    static readonly Events = { LEVEL_LOADED: 'hlsLevelLoaded', ERROR: 'hlsError' };
    static isSupported(): boolean {
      return true;
    }

    url = '';
    destroyed = false;
    private readonly handlers = new Map<string, (event: string, data: unknown) => void>();

    constructor() {
      hlsState.instances.push(this);
    }

    on(event: string, handler: (event: string, data: unknown) => void): void {
      this.handlers.set(event, handler);
    }

    loadSource(url: string): void {
      this.url = url;
    }

    attachMedia(): void {}

    destroy(): void {
      this.destroyed = true;
    }

    emit(event: string, data: unknown): void {
      this.handlers.get(event)?.(event, data);
    }
  }
  return { default: FakeHls };
});

vi.mock('@/config/live-video-sources', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/config/live-video-sources')>();
  Object.assign(catalog.original, real.LIVE_NEWS_SOURCES);
  Object.assign(catalog.news, real.LIVE_NEWS_SOURCES);
  return { ...real, LIVE_NEWS_SOURCES: catalog.news };
});

const HOUR = 60 * 60_000;
const POLL = LIVE_VIDEO_TIMING.pollMs;
const RECORDING_VERDICT_MS = LIVE_VIDEO_TIMING.durationGrowthWindowMs + 3 * LIVE_VIDEO_TIMING.pollMs;
const BLOOMBERG_HLS = 'https://streams.example/bloomberg/live.m3u8';

interface PanelInternals {
  element: HTMLElement;
  content: HTMLElement;
}

let panel: LiveNewsPanel | undefined;

function internals(): PanelInternals {
  if (!panel) throw new Error('panel not mounted');
  return panel as unknown as PanelInternals;
}

function mount(order: string[], options: { custom?: unknown[]; active?: string } = {}): void {
  localStorage.setItem(STORAGE_KEYS.liveChannels, JSON.stringify({ order, custom: options.custom ?? [], displayNameOverrides: {} }));
  if (options.active) localStorage.setItem(STORAGE_KEYS.activeChannel, JSON.stringify(options.active));
  panel = new LiveNewsPanel();
  document.body.appendChild(internals().element);
}

function content(): HTMLElement {
  return internals().content;
}

function contentButton(label: string): HTMLButtonElement {
  const match = Array.from(content().querySelectorAll('button')).find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`no "${label}" button in panel content`);
  return match;
}

function headerButton(title: string): HTMLButtonElement {
  const match = internals().element.querySelector<HTMLButtonElement>(`.panel-header button[title="${title}"]`);
  if (!match) throw new Error(`no "${title}" header button`);
  return match;
}

function channelButton(id: string): HTMLButtonElement {
  const match = internals().element.querySelector<HTMLButtonElement>(`.live-channel-btn[data-channel-id="${id}"]`);
  if (!match) throw new Error(`no channel button for ${id}`);
  return match;
}

function status(): HTMLElement | null {
  return content().querySelector('.live-news-status');
}

function offlineText(): string | null | undefined {
  return content().querySelector('.live-offline .offline-text')?.textContent;
}

function savedActiveChannel(): unknown {
  const raw = localStorage.getItem(STORAGE_KEYS.activeChannel);
  return raw === null ? null : JSON.parse(raw);
}

function showsPlayIcon(): boolean {
  return headerButton('Toggle playback').querySelector('polygon') !== null;
}

function api(): FakeYouTubeIframeApi {
  if (!loader.api) throw new Error('fake YouTube API not installed');
  return loader.api;
}

function latestHls(): FakeHlsInstance {
  const instance = hlsState.instances[hlsState.instances.length - 1];
  if (!instance) throw new Error('no HLS stream was loaded');
  return instance;
}

async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function playFromPlaceholder(): Promise<void> {
  contentButton('Play live feed').click();
  await flush();
}

let clock = Date.UTC(2030, 0, 1);

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  // Players carry real YouTube embed URLs; keep happy-dom from fetching them.
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  vi.useFakeTimers();
  // Failure memory is page-wide, so start each test a day past anything an earlier test remembered.
  clock += 24 * HOUR;
  vi.setSystemTime(clock);
  localStorage.clear();
  loader.api = createFakeYouTubeIframeApi();
  loader.blocked = false;
  hlsState.instances.length = 0;
  catalog.news.bloomberg = [BLOOMBERG_HLS, 'https://www.youtube.com/watch?v=QB5BNdBFujE'];
  catalog.news.cnn = ['https://www.youtube.com/watch?v=GotlA1KKWoo'];
});

afterEach(() => {
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
  for (const key of Object.keys(catalog.original)) catalog.news[key] = catalog.original[key]!;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('Live News live verification', () => {
  it('loads no player or stream before play intent', () => {
    mount(['bloomberg', 'cnn']);
    expect(api().players).toHaveLength(0);
    expect(hlsState.instances).toHaveLength(0);
    expect(content().textContent).toContain('Ready when you are');
  });

  it('plays a broadcaster HLS stream natively and clears the connecting cover only once it is live', async () => {
    mount(['bloomberg', 'cnn']);
    await playFromPlaceholder();

    const video = content().querySelector<HTMLVideoElement>('video.live-news-media');
    expect(video?.title).toBe('Bloomberg live feed');
    expect(api().players).toHaveLength(0);
    expect(latestHls().url).toBe(BLOOMBERG_HLS);
    expect(status()?.textContent).toBe('Connecting to Bloomberg…');

    latestHls().emit('hlsLevelLoaded', { details: { live: true } });
    await flush(POLL);

    expect(status()).toBeNull();
    expect(channelButton('bloomberg').classList.contains('offline')).toBe(false);
  });

  it('falls back to the verified YouTube stream when the HLS stream fails, and keeps the frame title', async () => {
    mount(['bloomberg']);
    await playFromPlaceholder();

    latestHls().emit('hlsError', { fatal: true, details: 'manifestLoadError' });
    await flush(POLL);

    expect(content().querySelector('video.live-news-media')).toBeNull();
    const player = api().playerFor('Bloomberg live feed');
    expect(player.embeddedVideoId).toBe('QB5BNdBFujE');
    player.goLive({ title: 'Bloomberg Business News Live' });
    await flush(POLL);

    expect(status()).toBeNull();
    expect(player.iframe.title).toBe('Bloomberg live feed');
  });

  it('explains why an explicitly chosen channel is offline and offers Retry, the next channel and YouTube', async () => {
    mount(['bloomberg', 'cnn']);
    await playFromPlaceholder();
    latestHls().emit('hlsLevelLoaded', { details: { live: true } });
    await flush(POLL);

    channelButton('cnn').click();
    await flush();
    expect(channelButton('cnn').getAttribute('aria-busy')).toBe('true');
    api().playerFor('CNN live feed').error(150);
    await flush(POLL);

    expect(channelButton('cnn').getAttribute('aria-busy')).toBeNull();
    expect(offlineText()).toBe('YouTube won’t play CNN inside other sites right now');
    expect(content().querySelector<HTMLAnchorElement>('.live-offline a.offline-retry')?.href).toBe('https://www.youtube.com/watch?v=GotlA1KKWoo');
    expect(channelButton('cnn').classList.contains('offline')).toBe(true);
    expect(showsPlayIcon()).toBe(true);
    expect(savedActiveChannel()).toBe('cnn');

    const playersBeforeRetry = api().players.length;
    contentButton('Retry').click();
    await flush();
    expect(api().players.length).toBe(playersBeforeRetry + 1);
    expect(status()?.textContent).toBe('Connecting to CNN…');

    api().playerFor('CNN live feed').error(150);
    await flush(POLL);
    contentButton('Play next channel').click();
    await flush();
    expect(channelButton('bloomberg').classList.contains('active')).toBe(true);
    expect(savedActiveChannel()).toBe('bloomberg');
  });

  it('skips an offline channel on an implicit start without saving the channel it lands on', async () => {
    mount(['cnn', 'bloomberg'], { active: 'cnn' });
    await playFromPlaceholder();

    api().playerFor('CNN live feed').error(150);
    await flush(POLL);

    expect(content().querySelector('.live-offline')).toBeNull();
    expect(channelButton('bloomberg').classList.contains('active')).toBe(true);
    expect(channelButton('cnn').classList.contains('offline')).toBe(true);
    expect(getActiveLiveMedia('live-news')?.streamId).toBe('bloomberg');
    expect(content().querySelector('video.live-news-media')?.getAttribute('title')).toBe('Bloomberg live feed');
    expect(savedActiveChannel()).toBe('cnn');
  });

  it('asks for a channel URL for a saved handle-only custom channel, without resolving the handle', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mount(['custom-foo-news'], { custom: [{ id: 'custom-foo-news', name: 'Foo News', handle: '@FooNews' }] });
    await playFromPlaceholder();

    expect(offlineText()).toBe('Add Foo News again with its channel URL (youtube.com/channel/UC…) or a live video URL');
    expect(contentButton('Manage channels')).toBeTruthy();
    expect(api().players).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('plays a user-added ended video labelled as a recording, never as live', async () => {
    mount(['custom-vid-AbCdEfGhIjK'], {
      custom: [{ id: 'custom-vid-AbCdEfGhIjK', name: 'My stream', handle: '@video', fallbackVideoId: 'AbCdEfGhIjK', useFallbackOnly: true }],
    });
    await playFromPlaceholder();

    const player = api().playerFor('My stream live feed');
    player.ready({ videoId: 'AbCdEfGhIjK', isLive: false, duration: 5_400, title: 'Yesterday' });
    player.setState(1);
    await flush(RECORDING_VERDICT_MS);

    expect(status()?.textContent).toBe('Recording');
    expect(player.destroyed).toBe(false);
    expect(content().querySelector('.live-offline')).toBeNull();
  });

  it('refuses a user-added http:// stream with an explanation', async () => {
    mount(['custom-hls-1'], { custom: [{ id: 'custom-hls-1', name: 'Local TV', hlsUrl: 'http://tv.example/live.m3u8', useFallbackOnly: true }] });
    await playFromPlaceholder();

    expect(offlineText()).toBe('Local TV uses an insecure (http) stream, which browsers block. Add it again with a secure (https) stream URL');
    expect(hlsState.instances).toHaveLength(0);
  });

  it('unmutes the player from the header sound button', async () => {
    catalog.news.bloomberg = ['https://www.youtube.com/watch?v=QB5BNdBFujE'];
    mount(['bloomberg']);
    await playFromPlaceholder();
    const player = api().playerFor('Bloomberg live feed');
    player.goLive();
    await flush(POLL);

    headerButton('Toggle sound').click();

    expect(player.muted).toBe(false);
  });

  it('leaves a stream the viewer paused alone at the idle stop', async () => {
    mount(['bloomberg']);
    await playFromPlaceholder();
    latestHls().emit('hlsLevelLoaded', { details: { live: true } });
    await flush(POLL);

    content().querySelector('video.live-news-media')?.dispatchEvent(new Event('pause'));
    await flush(2 * HOUR);

    expect(content().querySelector('.live-media-shell--idle')).toBeNull();
    expect(getActiveLiveMedia('live-news')).not.toBeNull();
    expect(showsPlayIcon()).toBe(true);
  });

  it('discloses a blocked player API instead of claiming the stream is live', async () => {
    loader.blocked = true;
    mount(['cnn']);
    await playFromPlaceholder();
    await flush(POLL);

    expect(status()?.textContent).toContain('Can’t confirm this stream is live');
    expect(content().querySelector('iframe[title="CNN live feed"]')).not.toBeNull();
  });
});
