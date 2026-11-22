const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const fs = require('fs');
const zlib = require('zlib');

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'Asia/Kolkata';
const COMBINE_GZ_PATH = './epg/combine.xml.gz';
const SAMSUNG_URL = 'https://i.mjh.nz/SamsungTVPlus/in.xml.gz';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeXML(str) {
  if (!str) return '';
  return String(str).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function getTataHeaders() {
  return {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://watch.tataplay.com',
    'Referer': 'https://watch.tataplay.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'content-type': 'application/json',
    'locale': 'ENG',
    'me': 'web'
  };
}

function getDishHeaders(token = '') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.dishtv.in/channel-guide.html',
    'Origin': 'https://www.dishtv.in',
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization-Token'] = token;
  }
  return headers;
}

function parseDishTime(str) {
  if (!str) return null;
  const d = dayjs(str);
  return d.isValid() ? d.valueOf() : null;
}

function parseXmltvDate(raw14, tzOffsetStr = '') {
  const y = raw14.slice(0, 4);
  const m = raw14.slice(4, 6);
  const d = raw14.slice(6, 8);
  const H = raw14.slice(8, 10);
  const M = raw14.slice(10, 12);
  const S = raw14.slice(12, 14);
  const isoLike = `${y}-${m}-${d}T${H}:${M}:${S}${tzOffsetStr || '+05:30'}`;
  const parsed = dayjs(isoLike);
  return parsed.isValid()
    ? parsed.valueOf()
    : dayjs.tz(`${y}-${m}-${d} ${H}:${M}:${S}`, 'YYYY-MM-DD HH:mm:ss', TZ).valueOf();
}

function loadProviderChannelsFromJson(targetProvider) {
  const candidateFiles = ['./tp_channels.json', './channels.json'];
  let filePath = null;

  for (const f of candidateFiles) {
    if (fs.existsSync(f)) {
      filePath = f;
      break;
    }
  }

  if (!filePath) return [];

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const list = Array.isArray(raw) ? raw : (raw.channels || []);
  const normTarget = String(targetProvider).trim().toLowerCase();

  return list
    .filter((item) => item && String(item.provider || '').trim().toLowerCase() === normTarget)
    .map((item) => ({
      id: String(item.id ?? item.channel_id ?? '').trim(),
      name: String(item.name ?? item.channel_name ?? '').trim(),
      logo: item.logo || ''
    }))
    .filter((ch) => ch.id);
}

// ==========================================
// जुन्या combine.xml.gz मधून चॅनेल्स व प्रोग्राम्स वाचणे
// ==========================================
function loadExistingCombineData() {
  const channelsMap = {};
  if (!fs.existsSync(COMBINE_GZ_PATH)) {
    console.log('[Cache] जुनी combine.xml.gz सापडली नाही (पहिला रन).');
    return channelsMap;
  }

  try {
    const xmlText = zlib.gunzipSync(fs.readFileSync(COMBINE_GZ_PATH)).toString('utf-8');
    const channelMatches = xmlText.match(/<channel\b[^>]*>[\s\S]*?<\/channel>/g) || [];
    for (const chBlock of channelMatches) {
      const idMatch = chBlock.match(/\bid="([^"]+)"/);
      if (!idMatch) continue;
      const id = idMatch[1];
      const nameMatch = chBlock.match(/<display-name[^>]*>([\s\S]*?)<\/display-name>/);
      const iconMatch = chBlock.match(/<icon\b[^>]*\bsrc="([^"]+)"/);

      channelsMap[id] = {
        id,
        name: nameMatch ? nameMatch[1].trim() : id,
        logo: iconMatch ? iconMatch[1].trim() : '',
        source: id.startsWith('dtv_') ? 'dishtv' : (id.startsWith('tp_') ? 'tataplay' : 'jiotv'),
        programmes: []
      };
    }

    const progMatches = xmlText.match(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g) || [];
    for (const pBlock of progMatches) {
      const attrsMatch = pBlock.match(/^<programme\b([^>]*)>/);
      if (!attrsMatch) continue;
      const attrs = attrsMatch[1];

      const chMatch = attrs.match(/\bchannel="([^"]+)"/);
      const startMatch = attrs.match(/\bstart="(\d{14})\s*([+-]\d{4})?"/);
      const stopMatch = attrs.match(/\bstop="(\d{14})\s*([+-]\d{4})?"/);
      if (!chMatch || !startMatch || !stopMatch) continue;

      const chId = chMatch[1];
      if (!channelsMap[chId]) {
        channelsMap[chId] = {
          id: chId,
          name: chId,
          logo: '',
          source: chId.startsWith('dtv_') ? 'dishtv' : (chId.startsWith('tp_') ? 'tataplay' : 'jiotv'),
          programmes: []
        };
      }

      const startMs = parseXmltvDate(startMatch[1], startMatch[2] || '+05:30');
      const stopMs = parseXmltvDate(stopMatch[1], stopMatch[2] || '+05:30');

      const titleMatch = pBlock.match(/<title[^>]*>([\s\S]*?)<\/title>/);
      const descMatch = pBlock.match(/<desc[^>]*>([\s\S]*?)<\/desc>/);
      const catMatch = pBlock.match(/<category[^>]*>([\s\S]*?)<\/category>/);
      const iconMatch = pBlock.match(/<icon\b[^>]*\bsrc="([^"]+)"/);

      channelsMap[chId].programmes.push({
        startMs,
        stopMs,
        title: titleMatch ? titleMatch[1].trim() : '',
        desc: descMatch ? descMatch[1].trim() : '',
        category: catMatch ? catMatch[1].trim() : '',
        icon: iconMatch ? iconMatch[1].trim() : ''
      });
    }

    console.log(`[Cache] जुन्या combine.xml.gz मधून ${Object.keys(channelsMap).length} चॅनेल्स लोड झाले.`);
  } catch (err) {
    console.error('[Cache] जुनी combine.xml.gz वाचताना एरर:', err.message);
  }

  return channelsMap;
}

// ==========================================
// DISHTV INCREMENTAL FETCH (फक्त Today + Future 1d)
// ==========================================
async function getDishToken() {
  try {
    const resp = await axios.post(
      'https://www.dishtv.in/services/epg/signin',
      {},
      { headers: getDishHeaders(), timeout: 15000 }
    );
    return resp.data?.token || null;
  } catch (err) {
    console.error('[DishTV] Token error:', err.message);
    return null;
  }
}

async function updateDishTVIncremental(channelsMap) {
  console.log('\n=== STEP 1/4: DishTV (Delete >8d old, Fetch Today + Future 1d) ===');
  const today = dayjs().tz(TZ);
  const cutoff8dMs = today.subtract(8, 'day').startOf('day').valueOf();

  for (const ch of Object.values(channelsMap)) {
    if (ch.source === 'dishtv') {
      ch.programmes = ch.programmes.filter((p) => p.stopMs > cutoff8dMs);
    }
  }

  const dishJsonChannels = loadProviderChannelsFromJson('DishTV');
  if (!dishJsonChannels.length) return;

  const allowedDishMap = new Map();
  for (const ch of dishJsonChannels) {
    allowedDishMap.set(ch.id, ch);
    const xmlId = `dtv_${ch.id}`;
    if (!channelsMap[xmlId]) {
      channelsMap[xmlId] = {
        id: xmlId,
        name: ch.name || `DishTV ${ch.id}`,
        logo: ch.logo || '',
        source: 'dishtv',
        programmes: []
      };
    }
  }

  const token = await getDishToken();
  if (!token) return;

  const datesToFetch = [
    today.format('DD/MM/YYYY'),
    today.add(1, 'day').format('DD/MM/YYYY')
  ];

  const totalPages = 107;

  for (const dateStr of datesToFetch) {
    console.log(`[DishTV] Fetching Today/Future Date: ${dateStr}`);
    for (let page = 1; page <= totalPages; page++) {
      try {
        const bodyData = {
          channelgenre: '',
          language: '',
          allowPastEvents: 'true',
          dataSize: 'large',
          pageNum: page,
          date: dateStr
        };

        const resp = await axios.post(
          `https://www.dishtv.in/services/epg/channels?pageNum=${page}&date=${encodeURIComponent(dateStr)}`,
          bodyData,
          { headers: getDishHeaders(token), timeout: 15000 }
        );

        const list = resp.data?.programDetailsByChannel || [];
        if (!list.length) break;

        for (const ch of list) {
          const rawId = String(ch.channelid);
          const jsonEntry = allowedDishMap.get(rawId);
          if (!jsonEntry) continue;

          const xmlId = `dtv_${rawId}`;
          if (jsonEntry.name) channelsMap[xmlId].name = jsonEntry.name;
          if (!channelsMap[xmlId].logo && ch.channelimage) {
            channelsMap[xmlId].logo = ch.channelimage;
          }

          for (const prg of (ch.programs || [])) {
            const startMs = parseDishTime(prg.start);
            const stopMs = parseDishTime(prg.stop);
            if (startMs && stopMs) {
              channelsMap[xmlId].programmes.push({
                startMs,
                stopMs,
                title: prg.title || '',
                desc: prg.desc || '',
                category: prg.genre || '',
                icon: prg.programmeurl || ''
              });
            }
          }
        }
      } catch (_) {
        continue;
      }
    }
  }
}

// ==========================================
// JIOTV INCREMENTAL FETCH (फक्त Today + Future 1d)
// ==========================================
async function updateJioTVIncremental(channelsMap) {
  console.log('\n=== STEP 2/4: JioTV (Delete >8d old, Fetch Today + Future 1d) ===');
  const today = dayjs().tz(TZ);
  const cutoff8dMs = today.subtract(8, 'day').startOf('day').valueOf();

  for (const ch of Object.values(channelsMap)) {
    if (ch.source === 'jiotv') {
      ch.programmes = ch.programmes.filter((p) => p.stopMs > cutoff8dMs);
    }
  }

  const jioJsonChannels = loadProviderChannelsFromJson('JioTV');
  if (!jioJsonChannels.length) return;

  const offsets = [0, 1];
  const chunk = 20;

  for (let i = 0; i < jioJsonChannels.length; i += chunk) {
    const batch = jioJsonChannels.slice(i, i + chunk);
    console.log(`[JioTV] Batch ${Math.floor(i / chunk) + 1} / ${Math.ceil(jioJsonChannels.length / chunk)}`);

    await Promise.all(batch.map(async (jioCh) => {
      const id = jioCh.id;
      const name = jioCh.name || `JioTV ${id}`;

      if (!channelsMap[id]) {
        channelsMap[id] = {
          id,
          name,
          logo: jioCh.logo || '',
          source: 'jiotv',
          programmes: []
        };
      }

      for (const off of offsets) {
        try {
          const resp = await axios.get(`https://iptvmax.site/api/epg/epg.php?id=${id}&offset=${off}`, { timeout: 10000 });
          const programs = Array.isArray(resp.data) ? resp.data : (resp.data?.epg || []);

          for (const prog of programs) {
            const start = dayjs(Number(prog.startEpoch));
            const stop = dayjs(Number(prog.endEpoch));
            if (start.isValid() && stop.isValid()) {
              channelsMap[id].programmes.push({
                startMs: start.valueOf(),
                stopMs: stop.valueOf(),
                title: prog.showname || '',
                desc: prog.description || '',
                icon: prog.assets?.['16:9']?.originalProgram || ''
              });
            }
          }
        } catch (_) {
          // ignore error
        }
      }
    }));

    await sleep(400);
  }
}

// ==========================================
// TATAPAY INCREMENTAL FETCH
// ==========================================
async function updateTataPlayIncremental(channelsMap) {
  console.log('\n=== STEP 3/4: TataPlay (Roll 8th day if >=8d else roll >1d, Fetch Today + Future 1d) ===');
  const today = dayjs().tz(TZ);
  const cutoff8dMs = today.subtract(8, 'day').startOf('day').valueOf();
  const cutoff1dMs = today.subtract(1, 'day').startOf('day').valueOf();

  for (const ch of Object.values(channelsMap)) {
    if (ch.source === 'tataplay') {
      const has8DaysData = ch.programmes.some((p) => p.startMs <= cutoff8dMs);
      const activeCutoff = has8DaysData ? cutoff8dMs : cutoff1dMs;
      ch.programmes = ch.programmes.filter((p) => p.stopMs > activeCutoff);
    }
  }

  const datesToFetch = [
    today.format('DD-MM-YYYY'),
    today.add(1, 'day').format('DD-MM-YYYY')
  ];

  for (const dateStr of datesToFetch) {
    let currentOffset = 0;
    const batchLimit = 20;
    let totalChannels = 836;

    while (currentOffset < totalChannels) {
      console.log(`[TataPlay] Date: ${dateStr} | Offset: ${currentOffset} / ${totalChannels}`);
      let responseData = null;
      let attempts = 4;

      while (attempts > 0) {
        try {
          const url = `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=${dateStr}&languageFilters=&genreFilters=&limit=${batchLimit}&offset=${currentOffset}`;
          const resp = await axios.get(url, { headers: getTataHeaders(), timeout: 20000 });
          responseData = resp.data?.data;
          break;
        } catch (err) {
          attempts--;
          const status = err.response?.status;
          console.error(`[TataPlay Err] Offset ${currentOffset} (Status: ${status || err.message}), retries left: ${attempts}`);
          await sleep(status === 429 ? 25000 : 6000);
        }
      }

      if (!responseData || !Array.isArray(responseData.channelList) || responseData.channelList.length === 0) {
        currentOffset += batchLimit;
        await sleep(1500);
        continue;
      }

      totalChannels = responseData.total || totalChannels;

      for (const ch of responseData.channelList) {
        if (!ch.title || ch.title === '.') continue;
        const id = `tp_${String(ch.id)}`;
        if (!channelsMap[id]) {
          channelsMap[id] = {
            id,
            name: ch.title,
            logo: ch.transparentImageUrl || ch.thumbnailImage || '',
            source: 'tataplay',
            programmes: []
          };
        }

        for (const epg of (ch.epg || [])) {
          const start = dayjs(Number(epg.startTime));
          const stop = dayjs(Number(epg.endTime));
          if (start.isValid() && stop.isValid()) {
            channelsMap[id].programmes.push({
              startMs: start.valueOf(),
              stopMs: stop.valueOf(),
              title: epg.title || '',
              desc: epg.desc || '',
              icon: epg.boxCoverImage || ''
            });
          }
        }
      }

      currentOffset += batchLimit;
      await sleep(2000);
    }
  }
}

// ==========================================
// SAMSUNG TV PLUS (फक्त JSON मधील provider: "samsungtvplus" चॅनेल्स | Present 24h + Future 1d 24h)
// ==========================================
async function fetchSamsung24hTodayAndTomorrow() {
  console.log('\n=== STEP 4/4: Samsung TV Plus (JSON samsungtvplus only | Present 24h + Future 1d 24h) ===');
  const samsungJsonChannels = loadProviderChannelsFromJson('samsungtvplus');
  console.log(`[Samsung] JSON मध्ये मिळालेले samsungtvplus चॅनेल्स: ${samsungJsonChannels.length}`);

  if (!samsungJsonChannels.length) {
    console.log('[Samsung] JSON मध्ये samsungtvplus चॅनेल्स नाहीत, स्किप करत आहे.');
    return { filteredChannels: [], samsungProgrammes: [] };
  }

  const allowedSamsungMap = new Map();
  for (const ch of samsungJsonChannels) {
    allowedSamsungMap.set(ch.id, ch);
  }

  const today = dayjs().tz(TZ);
  const windowStartMs = today.startOf('day').valueOf();
  const windowEndMs = today.add(1, 'day').endOf('day').valueOf();

  const samsungChannels = {};
  const samsungProgrammes = [];

  try {
    const resp = await axios.get(SAMSUNG_URL, { responseType: 'arraybuffer', timeout: 30000 });
    const xmlText = zlib.gunzipSync(Buffer.from(resp.data)).toString('utf-8');

    const chBlocks = xmlText.match(/<channel\b[^>]*>[\s\S]*?<\/channel>/g) || [];
    for (const block of chBlocks) {
      const idMatch = block.match(/\bid="([^"]+)"/);
      if (!idMatch) continue;
      const chId = idMatch[1];
      if (!allowedSamsungMap.has(chId)) continue;
      samsungChannels[chId] = block.trim();
    }

    const usedChannelIds = new Set();
    const progBlocks = xmlText.match(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g) || [];

    for (const block of progBlocks) {
      const attrsMatch = block.match(/^<programme\b([^>]*)>/);
      if (!attrsMatch) continue;
      const attrs = attrsMatch[1];

      const chMatch = attrs.match(/\bchannel="([^"]+)"/);
      const startMatch = attrs.match(/\bstart="(\d{14})\s*([+-]\d{4})?"/);
      const stopMatch = attrs.match(/\bstop="(\d{14})\s*([+-]\d{4})?"/);
      if (!chMatch || !startMatch || !stopMatch) continue;

      const chId = chMatch[1];
      if (!allowedSamsungMap.has(chId)) continue;

      const startMs = parseXmltvDate(startMatch[1], startMatch[2] || '+05:30');
      const stopMs = parseXmltvDate(stopMatch[1], stopMatch[2] || '+05:30');

      if (stopMs > windowStartMs && startMs < windowEndMs) {
        usedChannelIds.add(chId);
        samsungProgrammes.push(block.trim());
      }
    }

    const filteredChannels = [];
    for (const [id, jsonInfo] of allowedSamsungMap.entries()) {
      if (samsungChannels[id]) {
        filteredChannels.push(samsungChannels[id]);
      } else if (usedChannelIds.has(id)) {
        const displayName = escapeXML(jsonInfo.name || id);
        const logoTag = jsonInfo.logo ? `\n    <icon src="${escapeXML(jsonInfo.logo)}" />` : '';
        filteredChannels.push(`  <channel id="${escapeXML(id)}">\n    <display-name>${displayName}</display-name>${logoTag}\n  </channel>`.trim());
      }
    }

    console.log(`[Samsung] Matched JSON Channels: ${filteredChannels.length}, Programmes: ${samsungProgrammes.length}`);
    return { filteredChannels, samsungProgrammes };
  } catch (err) {
    console.error('[Samsung] Fetch error:', err.message);
    return { filteredChannels: [], samsungProgrammes: [] };
  }
}

// ==========================================
// FINAL ASSEMBLY -> फक्त ./epg/combine.xml.gz
// ==========================================
async function main() {
  const now = dayjs().tz(TZ);
  const past8StartMs = now.subtract(8, 'day').startOf('day').valueOf();
  const future1EndMs = now.add(1, 'day').endOf('day').valueOf();

  const channelsMap = loadExistingCombineData();

  await updateDishTVIncremental(channelsMap);
  await updateJioTVIncremental(channelsMap);
  await updateTataPlayIncremental(channelsMap);

  const { filteredChannels: samsungChannels, samsungProgrammes } = await fetchSamsung24hTodayAndTomorrow();

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Combine-EPG">\n';

  for (const ch of Object.values(channelsMap)) {
    xml += `  <channel id="${escapeXML(ch.id)}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  }

  for (const sCh of samsungChannels) {
    xml += `  ${sCh}\n`;
  }

  for (const ch of Object.values(channelsMap)) {
    const seen = new Set();
    for (const p of ch.programmes) {
      if (p.stopMs > past8StartMs && p.startMs < future1EndMs) {
        const key = `${p.startMs}_${p.stopMs}_${p.title}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const startStr = dayjs(p.startMs).tz(TZ).format('YYYYMMDDHHmmss ZZ');
        const stopStr = dayjs(p.stopMs).tz(TZ).format('YYYYMMDDHHmmss ZZ');

        xml += `  <programme start="${startStr}" stop="${stopStr}" channel="${escapeXML(ch.id)}">\n`;
        xml += `    <title lang="en">${escapeXML(p.title)}</title>\n`;
        if (p.desc) {
          xml += `    <desc lang="en">${escapeXML(p.desc)}</desc>\n`;
        }
        if (p.category) {
          xml += `    <category lang="en">${escapeXML(p.category)}</category>\n`;
        }
        if (p.icon) {
          xml += `    <icon src="${escapeXML(p.icon)}" />\n`;
        }
        xml += `  </programme>\n`;
      }
    }
  }

  for (const sProg of samsungProgrammes) {
    xml += `  ${sProg}\n`;
  }

  // फक्त Elitebeam_Movies आणि Elitebeam_Music चे प्रोग्राम्स जोडणे
  const customChannels = [
    { id: 'Elitebeam_Movies', name: 'EliteBeam Premium Movies', title: 'Epg EliteBeam Premium Movies' },
    { id: 'Elitebeam_Music', name: 'EliteBeam Premium Movies', title: 'EliteBeam Premium Movies' }
  ];

  for (const cCh of customChannels) {
    xml += `  <channel id="${escapeXML(cCh.id)}">\n`;
    xml += `    <display-name>${escapeXML(cCh.name)}</display-name>\n`;
    xml += `  </channel>\n`;

    let loopTime = now.subtract(8, 'day').startOf('day');
    while (loopTime.isBefore(future1EndMs)) {
      const nextTime = loopTime.add(2, 'hour');
      const startStr = loopTime.tz(TZ).format('YYYYMMDDHHmmss ZZ');
      const stopStr = nextTime.tz(TZ).format('YYYYMMDDHHmmss ZZ');

      xml += `  <programme start="${startStr}" stop="${stopStr}" channel="${escapeXML(cCh.id)}">\n`;
      xml += `    <title lang="en">${escapeXML(cCh.title)}</title>\n`;
      xml += `  </programme>\n`;

      loopTime = nextTime;
    }
  }

  xml += '</tv>';

  fs.rmSync('./epg', { recursive: true, force: true });
  fs.mkdirSync('./epg', { recursive: true });
  fs.writeFileSync(COMBINE_GZ_PATH, zlib.gzipSync(xml));

  console.log('\n✅ फक्त ./epg/combine.xml.gz तयार झाली आहे!');
}

main().catch((err) => {
  console.error('Fatal Error:', err);
});
