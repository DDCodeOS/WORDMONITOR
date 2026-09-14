import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  catalogTargets,
  classifyHlsPlaylist,
  exitCodeFor,
  formatCheckLine,
  observationFromRecord,
  parseCheckArgs,
  probeYouTubeCandidates,
  runCheck,
  slotStatus,
} from '../scripts/check-live-video-sources.mjs';
import { extractLiveVideoSurfaces, readLiveVideoSurfaces } from '../scripts/lib/live-video-surfaces.mjs';
import { LIVE_NEWS_SOURCES, WEBCAM_SOURCES } from '../src/config/live-video-sources.ts';
import { LIVE_VIDEO_TIMING, parseSourceEntry } from '../src/services/live-video/model.ts';

const parsed = (entry) => parseSourceEntry(entry);

describe('parseCheckArgs', () => {
  it('reads bare entries in order', () => {
    assert.deepEqual(parseCheckArgs(['zp6LNSoq000', 'https://www.youtube.com/watch?v=vk5BHoDxXf0']), {
      mode: 'entries',
      entries: [
        { name: null, entry: 'zp6LNSoq000' },
        { name: null, entry: 'https://www.youtube.com/watch?v=vk5BHoDxXf0' },
      ],
    });
  });

  it('reads name=entry labels without splitting a URL query', () => {
    assert.deepEqual(parseCheckArgs(['seoul=https://www.youtube.com/watch?v=vk5BHoDxXf0']), {
      mode: 'entries',
      entries: [{ name: 'seoul', entry: 'https://www.youtube.com/watch?v=vk5BHoDxXf0' }],
    });
    assert.deepEqual(parseCheckArgs(['https://www.youtube.com/watch?v=vk5BHoDxXf0']).entries[0].name, null);
  });

  it('answers --help', () => {
    assert.deepEqual(parseCheckArgs(['--help']), { mode: 'help' });
  });

  it('rejects an empty invocation and unknown flags', () => {
    assert.throws(() => parseCheckArgs([]), /Usage/);
    assert.throws(() => parseCheckArgs(['--everything']), /Unknown option --everything/);
  });

  it('reads the catalog modes', () => {
    assert.deepEqual(parseCheckArgs(['--all']), { mode: 'all' });
    assert.deepEqual(parseCheckArgs(['--slot', 'webcams/kyiv']), { mode: 'slot', slot: 'webcams/kyiv' });
    assert.throws(() => parseCheckArgs(['--slot']), /--slot needs a slot/);
  });

  it('reads --report only alongside --all', () => {
    assert.deepEqual(parseCheckArgs(['--all', '--report', 'audit.json']), { mode: 'all', report: 'audit.json' });
    assert.deepEqual(parseCheckArgs(['--report', 'audit.json', '--all']), { mode: 'all', report: 'audit.json' });
    assert.throws(() => parseCheckArgs(['--all', '--report']), /--report needs a file/);
    assert.throws(() => parseCheckArgs(['--all', '--report', '--all']), /--report needs a file/);
    assert.throws(() => parseCheckArgs(['--report', 'audit.json']), /--report needs --all/);
    assert.throws(() => parseCheckArgs(['--slot', 'webcams/kyiv', '--report', 'audit.json']), /--report needs --all/);
  });
});

describe('catalog modes', () => {
  const catalog = {
    webcams: {
      kyiv: ['https://www.youtube.com/watch?v=e2gC37ILQmk'],
      'new-york': ['JQ_jwk_7OVE', 'VGnFLdQW39A'],
      'tel-aviv': [],
    },
    news: {
      cnn: ['https://www.youtube.com/watch?v=GotlA1KKWoo'],
      rtve: [],
    },
    canaries: ['https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg'],
  };

  it('checks every entry of one slot, in try order', () => {
    assert.deepEqual(catalogTargets({ mode: 'slot', slot: 'webcams/new-york' }, catalog), {
      entries: [
        { name: 'webcams/new-york', entry: 'JQ_jwk_7OVE' },
        { name: 'webcams/new-york#2', entry: 'VGnFLdQW39A' },
      ],
      empty: [],
    });
    assert.deepEqual(catalogTargets({ mode: 'slot', slot: 'webcams/tel-aviv' }, catalog), { entries: [], empty: ['webcams/tel-aviv'] });
    assert.throws(() => catalogTargets({ mode: 'slot', slot: 'webcams/atlantis' }, catalog), /Unknown slot webcams\/atlantis/);
  });

  it('checks every slot and the canaries with --all', () => {
    const { entries, empty } = catalogTargets({ mode: 'all' }, catalog);
    assert.deepEqual(entries.map((row) => row.name), ['webcams/kyiv', 'webcams/new-york', 'webcams/new-york#2', 'live-news/cnn', 'canary/1']);
    assert.deepEqual(empty, ['webcams/tel-aviv', 'live-news/rtve']);
  });

  it('checks one Live News channel by slot', () => {
    assert.deepEqual(catalogTargets({ mode: 'slot', slot: 'live-news/cnn' }, catalog), {
      entries: [{ name: 'live-news/cnn', entry: 'https://www.youtube.com/watch?v=GotlA1KKWoo' }],
      empty: [],
    });
  });

  it('reports a slot with no entries and exits 1 even when every stream is live', async () => {
    const lines = [];
    const live = { verdict: { verdict: 'live', video: { videoId: 'e2gC37ILQmk', isLive: true, title: 'Ukraine', author: 'TVL' } } };
    const code = await runCheck(['--all'], {
      write: (line) => lines.push(line),
      catalog,
      probeYouTube: async (candidates) => candidates.map(() => live),
      probeHls: async () => [],
    });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /^EMPTY\s+webcams\/tel-aviv\s+no entries/m);
    assert.match(lines.join('\n'), /^LIVE\s+webcams\/new-york#2/m);
  });
});

describe('formatCheckLine', () => {
  it('prints a live video with its title, author and the line to paste', () => {
    const text = formatCheckLine({
      name: 'jerusalem',
      parsed: parsed('https://www.youtube.com/watch?v=zp6LNSoq000'),
      verdict: { verdict: 'live', video: { videoId: 'zp6LNSoq000', isLive: true, title: 'Western Wall', author: 'Mt. of Olives Prayer Bridge' } },
    });
    assert.match(text, /^LIVE\s+jerusalem\s+https:\/\/www\.youtube\.com\/watch\?v=zp6LNSoq000\s+"Western Wall" by Mt\. of Olives Prayer Bridge$/m);
    assert.match(text, /why: YouTube reports a live stream \(isLive=true\)/);
    assert.match(text, /paste: 'https:\/\/www\.youtube\.com\/watch\?v=zp6LNSoq000'/);
  });

  it('prints the video a live channel embed resolved to', () => {
    const text = formatCheckLine({
      name: null,
      parsed: parsed('UCknLrEdhRCp1aegoMqRaCZg'),
      verdict: { verdict: 'live', video: { videoId: 'LuKwFajn37U', isLive: true, title: 'DW News livestream', author: 'DW News' } },
    });
    assert.match(text, /https:\/\/www\.youtube\.com\/channel\/UCknLrEdhRCp1aegoMqRaCZg → LuKwFajn37U/);
    assert.match(text, /paste: 'https:\/\/www\.youtube\.com\/channel\/UCknLrEdhRCp1aegoMqRaCZg'/);
  });

  it('explains a stream that never started and a missing live signal', () => {
    const entry = parsed('_7nBPHF-hAE');
    const notStarted = formatCheckLine({ name: null, parsed: entry, verdict: { verdict: 'failed', outcome: { kind: 'not-started' } } });
    assert.match(notStarted, /^FAILED/m);
    assert.match(notStarted, /why: scheduled or not started/);
    const noSignal = formatCheckLine({ name: null, parsed: entry, verdict: { verdict: 'unverifiable', reason: 'live-signal-missing' } });
    assert.match(noSignal, /^UNVERIFIED/m);
    assert.match(noSignal, /why: .*isLive missing/);
  });

  it('explains an ended recording with its duration and gives no paste line', () => {
    const text = formatCheckLine({
      name: 'kyiv',
      parsed: parsed('-Q7FuPINDjA'),
      verdict: { verdict: 'recording', video: { videoId: '-Q7FuPINDjA', isLive: false, title: 'LIVE: View of Kyiv', author: 'DW News' } },
      durationSeconds: 24_181,
    });
    assert.match(text, /^RECORDING\s+kyiv/m);
    assert.match(text, /why: ended recording \(isLive=false, duration 24,181 s\)/);
    assert.doesNotMatch(text, /paste:/);
  });

  it('prints the author without empty quotes when the title is missing', () => {
    const text = formatCheckLine({
      name: null,
      parsed: parsed('zp6LNSoq000'),
      verdict: { verdict: 'live', video: { videoId: 'zp6LNSoq000', isLive: true, title: '', author: 'Mt. of Olives Prayer Bridge' } },
    });
    assert.match(text, /zp6LNSoq000\s+by Mt\. of Olives Prayer Bridge$/m);
    assert.doesNotMatch(text, /""/);
  });

  it('explains a player error', () => {
    const text = formatCheckLine({
      name: null,
      parsed: parsed('e34xb-Fbl0U'),
      verdict: { verdict: 'failed', outcome: { kind: 'player-error', code: 150 } },
    });
    assert.match(text, /^FAILED\s+https:\/\/www\.youtube\.com\/watch\?v=e34xb-Fbl0U$/m);
    assert.match(text, /why: YouTube player error 150/);
  });

  it('explains an entry that cannot be checked', () => {
    const text = formatCheckLine({ name: 'cnn', parsed: parsed('@CNN') });
    assert.match(text, /^INVALID\s+cnn\s+@CNN$/m);
    assert.match(text, /why: .*youtube\.com\/channel\/UC/);
  });

  it('explains HLS verdicts', () => {
    const entry = parsed('https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8');
    assert.match(formatCheckLine({ name: null, parsed: entry, verdict: { verdict: 'live', video: null } }), /why: HLS playlist is live \(playback not checked outside a browser\)$/m);
    assert.match(formatCheckLine({ name: null, parsed: entry, verdict: { verdict: 'failed', outcome: { kind: 'hls-http', status: 403 } } }), /why: manifest returned HTTP 403/);
  });
});

describe('exitCodeFor', () => {
  it('is 0 only when every entry is live', () => {
    const live = { parsed: parsed('zp6LNSoq000'), verdict: { verdict: 'live', video: null } };
    const recording = { parsed: parsed('-Q7FuPINDjA'), verdict: { verdict: 'recording', video: null } };
    const invalid = { parsed: parsed('@CNN') };
    assert.equal(exitCodeFor([live, live]), 0);
    assert.equal(exitCodeFor([live, recording]), 1);
    assert.equal(exitCodeFor([live, invalid]), 1);
    assert.equal(exitCodeFor([]), 1);
  });
});

describe('observationFromRecord', () => {
  it('maps a page record onto the classifier observation', () => {
    assert.deepEqual(observationFromRecord({
      kind: 'channel',
      apiBlocked: false,
      mounted: true,
      elapsedMs: 4_200,
      frameLoaded: true,
      readyAtMs: 1_100,
      errorCode: null,
      video: { videoId: '', isLive: undefined, title: '', author: '' },
      durations: [],
    }), {
      transport: 'youtube',
      api: 'loaded',
      candidate: 'channel',
      elapsedMs: 4_200,
      frameLoaded: true,
      readyAtMs: 1_100,
      errorCode: null,
      video: { videoId: '', isLive: undefined, title: '', author: '' },
      durations: [],
    });
  });

  it('reads missing readings as not yet observed', () => {
    const observation = observationFromRecord({ kind: 'video', apiBlocked: false, mounted: true, elapsedMs: 1_000, frameLoaded: true });
    assert.equal(observation.errorCode, null);
    assert.equal(observation.readyAtMs, null);
    assert.equal(observation.video, null);
    assert.deepEqual(observation.durations, []);
  });

  it('reports a blocked IFrame API', () => {
    assert.deepEqual(observationFromRecord({ kind: 'video', apiBlocked: true }), { transport: 'youtube', api: 'blocked' });
  });
});

describe('probeYouTubeCandidates', () => {
  it('polls a fake page until every candidate settles, without a browser', async () => {
    const snapshots = [
      [
        { kind: 'video', apiBlocked: false, mounted: true, elapsedMs: 1_000, frameLoaded: true, readyAtMs: null, errorCode: null, video: null, durations: [] },
        { kind: 'video', apiBlocked: false, mounted: true, elapsedMs: 1_000, frameLoaded: true, readyAtMs: null, errorCode: 150, video: null, durations: [] },
      ],
      [
        { kind: 'video', apiBlocked: false, mounted: true, elapsedMs: 2_000, frameLoaded: true, readyAtMs: 1_500, errorCode: null, video: { videoId: 'zp6LNSoq000', isLive: true, title: 'Western Wall', author: 'Mt. of Olives' }, durations: [{ atMs: 1_900, seconds: 90_000 }] },
        { kind: 'video', apiBlocked: false, mounted: true, elapsedMs: 2_000, frameLoaded: true, readyAtMs: null, errorCode: 150, video: null, durations: [] },
      ],
    ];
    let reads = 0;
    const sleeps = [];
    const page = {
      async mount(items) {
        assert.deepEqual(items, [{ kind: 'video', id: 'zp6LNSoq000' }, { kind: 'video', id: 'e34xb-Fbl0U' }]);
      },
      async read() {
        return snapshots[Math.min(reads++, snapshots.length - 1)];
      },
    };
    const results = await probeYouTubeCandidates(
      [parsed('zp6LNSoq000').candidate, parsed('e34xb-Fbl0U').candidate],
      { page, sleep: async (ms) => { sleeps.push(ms); } },
    );
    assert.equal(reads, 2);
    assert.deepEqual(sleeps, [LIVE_VIDEO_TIMING.pollMs]);
    assert.equal(results[0].verdict.verdict, 'live');
    assert.equal(results[0].durationSeconds, 90_000);
    assert.deepEqual(results[1].verdict, { verdict: 'failed', outcome: { kind: 'player-error', code: 150 } });
  });
});

describe('classifyHlsPlaylist', () => {
  it('reads live, VOD and non-playlist bodies', () => {
    assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n'), 'live');
    assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n'), 'vod');
    assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.0,\nseg1.ts\n'), 'vod');
    assert.equal(classifyHlsPlaylist('<html>blocked</html>'), 'unknown');
  });
});

describe('runCheck', () => {
  it('prints one block per entry and exits 1 when any entry is not live', async () => {
    const out = [];
    const code = await runCheck(['jerusalem=zp6LNSoq000', 'kyiv=-Q7FuPINDjA', 'cnn=@CNN', 'aje=https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8'], {
      write: (line) => out.push(line),
      probeYouTube: async (candidates) => candidates.map((candidate) => (candidate.videoId === 'zp6LNSoq000'
        ? { verdict: { verdict: 'live', video: { videoId: 'zp6LNSoq000', isLive: true, title: 'Western Wall', author: 'Mt. of Olives' } } }
        : { verdict: { verdict: 'recording', video: { videoId: '-Q7FuPINDjA', isLive: false, title: 'Kyiv', author: 'DW News' } }, durationSeconds: 24_181 })),
      probeHls: async (candidates) => candidates.map(() => ({ verdict: { verdict: 'live', video: null } })),
    });
    const text = out.join('\n');
    assert.equal(code, 1);
    assert.match(text, /^LIVE\s+jerusalem/m);
    assert.match(text, /^RECORDING\s+kyiv/m);
    assert.match(text, /^INVALID\s+cnn/m);
    assert.match(text, /^LIVE\s+aje/m);
    assert.match(text, /^2 of 4 entries are not live\.$/m);
  });

  it('calls a live HLS playlist live from Node and says playback was not checked', async () => {
    const out = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n');
    try {
      const code = await runCheck(['aje=https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8'], {
        write: (line) => out.push(line),
        probeYouTube: async () => { throw new Error('no YouTube entries were given'); },
      });
      const text = out.join('\n');
      assert.equal(code, 0);
      assert.match(text, /^LIVE\s+aje/m);
      assert.match(text, /why: HLS playlist is live \(playback not checked outside a browser\)$/m);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('exits 0 when every entry is live and never launches a probe for an empty group', async () => {
    const code = await runCheck(['zp6LNSoq000'], {
      write: () => {},
      probeYouTube: async (candidates) => candidates.map(() => ({ verdict: { verdict: 'live', video: null } })),
      probeHls: async () => { throw new Error('no HLS entries were given'); },
    });
    assert.equal(code, 0);
  });

  it('prints usage and exits 2 on bad arguments', async () => {
    const out = [];
    assert.equal(await runCheck([], { write: (line) => out.push(line) }), 2);
    assert.match(out.join('\n'), /Usage/);
  });
});

describe('slotStatus', () => {
  const live = { verdict: 'live', unverifiableFromRunner: false };
  const dead = { verdict: 'failed', unverifiableFromRunner: false };
  const geo = { verdict: 'failed', unverifiableFromRunner: true };

  it('names what a slot needs from its attempts in try order', () => {
    assert.equal(slotStatus([]), 'empty');
    assert.equal(slotStatus([live, dead]), 'ok');
    assert.equal(slotStatus([dead, live]), 'degraded');
    assert.equal(slotStatus([dead, dead]), 'needs-replacement');
  });

  it('never counts an attempt the runner could not verify as a failure', () => {
    assert.equal(slotStatus([geo, live]), 'ok');
    assert.equal(slotStatus([geo, dead, live]), 'degraded');
    assert.equal(slotStatus([geo]), 'unverifiable-from-runner');
    assert.equal(slotStatus([dead, geo]), 'unverifiable-from-runner');
  });
});

describe('audit report (--all --report)', () => {
  const watch = (id) => `https://www.youtube.com/watch?v=${id}`;
  const BLOOMBERG_HLS = 'https://bloomberg.com/media-manifest/streams/us.m3u8';
  const BBC_HLS = 'https://vs-hls-push-uk.live.fastly.md.bbci.co.uk/x=4/iptv_hd_abr_v1.m3u8';
  const CANARY = 'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg';
  const catalog = {
    webcams: {
      jerusalem: [watch('zp6LNSoq000')],
      'middle-east': [],
      kyiv: [watch('e2gC37ILQmk'), watch('VGnFLdQW39A')],
      washington: [watch('oDCAAfOSqvA')],
      taipei: [watch('z_fY1pj1VBw')],
      tokyo: [watch('_k-5U7IeK8g')],
      sydney: [watch('5uZa3-RMFos')],
    },
    gridPriority: ['jerusalem', 'middle-east', 'kyiv', 'washington', 'taipei', 'tokyo'],
    news: {
      bloomberg: [BLOOMBERG_HLS, watch('QB5BNdBFujE')],
      'bbc-news': [BBC_HLS],
      yahoo: [watch('KQp-e_XQnDE')],
      rtve: [],
    },
    canaries: [CANARY],
  };
  const surfaces = {
    webcamFeeds: [
      { id: 'jerusalem', region: 'middle-east' },
      { id: 'middle-east', region: 'middle-east' },
      { id: 'kyiv', region: 'europe' },
      { id: 'washington', region: 'americas' },
      { id: 'taipei', region: 'asia' },
      { id: 'tokyo', region: 'asia' },
      { id: 'sydney', region: 'asia' },
    ],
    gridCells: 4,
    newsDefaults: { full: ['bloomberg'], tech: ['bloomberg', 'yahoo'] },
    newsOptional: ['bloomberg', 'yahoo', 'bbc-news', 'rtve'],
  };
  const live = (videoId, title = 'Live cam', author = 'Cams') => ({
    verdict: { verdict: 'live', video: { videoId, isLive: true, title, author } },
    durationSeconds: 90_000,
    verdictAtMs: 2_100,
  });
  const youtubeVerdicts = {
    zp6LNSoq000: { verdict: { verdict: 'failed', outcome: { kind: 'player-error', code: 150 } }, durationSeconds: null, verdictAtMs: 1_200 },
    e2gC37ILQmk: {
      verdict: { verdict: 'recording', video: { videoId: 'e2gC37ILQmk', isLive: false, title: 'LIVE: View of Kyiv', author: 'DW News' } },
      durationSeconds: 24_181,
      verdictAtMs: 8_400,
    },
    'KQp-e_XQnDE': { verdict: { verdict: 'unverifiable', reason: 'player-api-silent' }, durationSeconds: null, verdictAtMs: 15_000 },
  };
  const probeYouTube = async (candidates) => candidates.map((candidate) => (candidate.kind === 'channel'
    ? live('gCNeDWCI0vo', 'Al Jazeera English - Live', 'Al Jazeera English')
    : youtubeVerdicts[candidate.videoId] ?? live(candidate.videoId)));
  const probeHls = async (candidates) => candidates.map(() => ({ verdict: { verdict: 'failed', outcome: { kind: 'hls-http', status: 403 } } }));

  async function audit(argv, overrides = {}) {
    const lines = [];
    const writes = [];
    const code = await runCheck(argv, {
      write: (line) => lines.push(line),
      catalog,
      surfaces,
      probeYouTube,
      probeHls,
      now: () => new Date('2026-09-15T05:17:00.000Z'),
      writeReport: (path, text) => writes.push({ path, report: JSON.parse(text) }),
      ...overrides,
    });
    return { code, lines, writes };
  }

  it('writes the report without changing the human output or the exit code', async () => {
    const plain = await audit(['--all']);
    const reported = await audit(['--all', '--report', 'audit.json']);
    assert.equal(plain.code, 1);
    assert.equal(reported.code, plain.code);
    assert.deepEqual(reported.lines, plain.lines);
    assert.deepEqual(plain.writes, []);
    assert.equal(reported.writes.length, 1);
    assert.equal(reported.writes[0].path, 'audit.json');
    assert.equal(reported.writes[0].report.checkedAt, '2026-09-15T05:17:00.000Z');
  });

  it('places each slot where customers see it and names the slot shown in its place', async () => {
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json']);
    assert.deepEqual(report.slots.map((slot) => [slot.slot, slot.surface, slot.shownByDefault, slot.status, slot.shownInstead]), [
      ['webcams/jerusalem', 'Webcam grid #1', true, 'needs-replacement', 'webcams/taipei'],
      ['webcams/middle-east', 'Webcam grid #2', true, 'empty', 'webcams/tokyo'],
      ['webcams/kyiv', 'Webcam grid #3', true, 'degraded', null],
      ['webcams/washington', 'Webcam grid #4', true, 'ok', null],
      ['webcams/taipei', 'Webcam grid #1', true, 'ok', null],
      ['webcams/tokyo', 'Webcam grid #2', true, 'ok', null],
      ['webcams/sydney', 'Webcam (Asia)', false, 'ok', null],
      ['live-news/bloomberg', 'Live News default (full, tech)', true, 'ok', null],
      ['live-news/bbc-news', 'Live News optional', false, 'unverifiable-from-runner', null],
      ['live-news/yahoo', 'Live News default (tech)', true, 'needs-replacement', null],
      ['live-news/rtve', 'Live News optional', false, 'empty', null],
    ]);
  });

  it('keeps a wall slot with no spare left in its cell with nothing shown instead', async () => {
    const thin = { ...catalog, webcams: { ...catalog.webcams, taipei: [], tokyo: [] } };
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog: thin });
    const bySlot = new Map(report.slots.map((slot) => [slot.slot, slot]));
    assert.equal(bySlot.get('webcams/jerusalem').shownInstead, null);
    assert.equal(bySlot.get('webcams/middle-east').shownInstead, null);
    assert.equal(bySlot.get('webcams/taipei').surface, 'Webcam (Asia)');
    assert.equal(bySlot.get('webcams/taipei').shownByDefault, false);
  });

  it('records every attempt in try order with its verdict and evidence', async () => {
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json']);
    const bySlot = new Map(report.slots.map((slot) => [slot.slot, slot]));

    const [jerusalem] = bySlot.get('webcams/jerusalem').attempts;
    assert.equal(jerusalem.entry, watch('zp6LNSoq000'));
    assert.equal(jerusalem.kind, 'video');
    assert.equal(jerusalem.verdict, 'failed');
    assert.equal(jerusalem.unverifiableFromRunner, false);
    assert.match(jerusalem.why, /YouTube player error 150/);
    assert.equal(jerusalem.evidence.errorCode, 150);
    assert.equal(jerusalem.evidence.verdictAtMs, 1_200);

    const [recording, backup] = bySlot.get('webcams/kyiv').attempts;
    assert.equal(recording.verdict, 'recording');
    assert.match(recording.why, /ended recording \(isLive=false, duration 24,181 s\)/);
    assert.deepEqual(
      [recording.evidence.title, recording.evidence.author, recording.evidence.isLive, recording.evidence.durationSeconds],
      ['LIVE: View of Kyiv', 'DW News', false, 24_181],
    );
    assert.equal(backup.verdict, 'live');

    const [geo] = bySlot.get('live-news/bbc-news').attempts;
    assert.equal(geo.kind, 'hls');
    assert.equal(geo.unverifiableFromRunner, true);
    assert.equal(geo.evidence.httpStatus, 403);

    const [silent] = bySlot.get('live-news/yahoo').attempts;
    assert.equal(silent.verdict, 'unverifiable');
    assert.equal(silent.unverifiableFromRunner, false, 'a player that never became ready is dead for viewers too');

    assert.deepEqual(bySlot.get('live-news/rtve').attempts, []);
    assert.deepEqual(report.canaries.map((canary) => [canary.entry, canary.kind, canary.verdict, canary.evidence.author]), [
      [CANARY, 'channel', 'live', 'Al Jazeera English'],
    ]);
  });

  it('counts an HLS network timeout as unverifiable from the runner, and a host that is gone as dead', async () => {
    const hlsOnly = { webcams: {}, gridPriority: [], news: { bloomberg: [BLOOMBERG_HLS] }, canaries: [CANARY] };
    const failWith = (detail) => async (candidates) => candidates.map(() => ({ verdict: { verdict: 'failed', outcome: { kind: 'hls-fatal', detail } } }));
    const cases = [
      ['UND_ERR_CONNECT_TIMEOUT', true],
      ['UND_ERR_HEADERS_TIMEOUT', true],
      ['UND_ERR_BODY_TIMEOUT', true],
      ['ETIMEDOUT', true],
      ['ENOTFOUND', false],
      ['ECONNREFUSED', false],
      ['not an HLS media playlist', false],
    ];
    for (const [detail, unverifiable] of cases) {
      const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog: hlsOnly, probeHls: failWith(detail) });
      const [slot] = report.slots;
      assert.equal(slot.attempts[0].unverifiableFromRunner, unverifiable, detail);
      assert.equal(slot.status, unverifiable ? 'unverifiable-from-runner' : 'needs-replacement', detail);
    }
  });

  it('fails before probing when a slot has no place on the dashboard', async () => {
    let probed = false;
    const unplaced = { ...surfaces, webcamFeeds: surfaces.webcamFeeds.filter((feed) => feed.id !== 'sydney') };
    await assert.rejects(
      audit(['--all', '--report', 'audit.json'], { surfaces: unplaced, probeYouTube: async () => { probed = true; return []; } }),
      /webcams\/sydney/,
    );
    assert.equal(probed, false);
  });
});

describe('live video surfaces', () => {
  it('reads the webcam wall, regions and Live News defaults from the panels', () => {
    const surfaces = readLiveVideoSurfaces();
    assert.deepEqual(surfaces.webcamFeeds.map((feed) => feed.id).sort(), Object.keys(WEBCAM_SOURCES).sort());
    assert.ok(surfaces.webcamFeeds.every((feed) => /^[a-z-]+$/.test(feed.region)));
    assert.equal(surfaces.gridCells, 4);
    assert.deepEqual(Object.keys(surfaces.newsDefaults).sort(), ['full', 'tech']);
    assert.ok(surfaces.newsDefaults.full.includes('bloomberg'));
    const newsIds = new Set([...Object.values(surfaces.newsDefaults).flat(), ...surfaces.newsOptional]);
    assert.deepEqual([...newsIds].sort(), Object.keys(LIVE_NEWS_SOURCES).sort());
  });

  it('fails loudly when a panel list can no longer be read', () => {
    const webcamsPanel = "const WEBCAM_FEEDS: WebcamFeed[] = [\n  { id: 'kyiv', city: 'Ukraine', country: 'Ukraine', region: 'europe' },\n];\nconst MAX_GRID_CELLS = 4;\n";
    const newsPanel = "const FULL_LIVE_CHANNELS: LiveChannel[] = [\n  { id: 'bloomberg', name: 'Bloomberg' },\n];\nexport const OPTIONAL_LIVE_CHANNELS: LiveChannel[] = [\n  { id: 'bloomberg', name: 'Bloomberg' },\n];\n";
    assert.deepEqual(extractLiveVideoSurfaces({ webcamsPanel, newsPanel }), {
      webcamFeeds: [{ id: 'kyiv', region: 'europe' }],
      gridCells: 4,
      newsDefaults: { full: ['bloomberg'] },
      newsOptional: ['bloomberg'],
    });
    assert.throws(() => extractLiveVideoSurfaces({ webcamsPanel: '', newsPanel }), /WEBCAM_FEEDS/);
    assert.throws(() => extractLiveVideoSurfaces({ webcamsPanel: webcamsPanel.replace("region: 'europe'", 'region: REGION'), newsPanel }), /WEBCAM_FEEDS/);
    assert.throws(() => extractLiveVideoSurfaces({ webcamsPanel: webcamsPanel.replace('MAX_GRID_CELLS = 4', 'MAX_GRID_CELLS = CELLS'), newsPanel }), /MAX_GRID_CELLS/);
    assert.throws(() => extractLiveVideoSurfaces({ webcamsPanel, newsPanel: newsPanel.replace(/export const OPTIONAL[\s\S]*/, '') }), /OPTIONAL_LIVE_CHANNELS/);
    assert.throws(() => extractLiveVideoSurfaces({ webcamsPanel, newsPanel: newsPanel.replace("{ id: 'bloomberg', name: 'Bloomberg' },\n];\nexport", "{ id: ID, name: 'Bloomberg' },\n];\nexport") }), /FULL_LIVE_CHANNELS/);
  });
});
