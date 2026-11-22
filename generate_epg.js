const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const fs = require('fs');
const zlib = require('zlib');

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'Asia/Kolkata';
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

function loadProviderChannelsFromJson(targetProvider) {
  const candidateFiles = ['./tp_channels.json', './channels.json'];
  let filePath = null;

  for (const f of candidateFiles) {
    if (fs.existsSync(f)) {
      filePath = f;
      break;
    }
  }

  if (!filePath) {
    console.log('[JSON] tp_channels.json किंवा channels.json सापडली नाही.');
    return [];
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const list = Array.isArray(raw) ? raw : (raw.channels || []);
  const normTarget = targetProvider.toLowerCase();

  return list
    .filter((item) => item && String(item.provider || '').trim().toLowerCase() === normTarget)
    .map((item) => ({
      id: String(item.id).trim(),
      name: String(item.name || '').trim(),
      logo: item.logo || ''
    }))
    .filter((ch) => ch.id);
}

// ==========================================
// STEP 1: DISHTV (JSON मधून | Past 8d + Today + Future 1d)
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

async function fetchDishTVData() {
  console.log('\n=== STEP 1/3: DishTV (Past 8d + Today + Future 1d) ===');
  const dishJsonChannels = loadProviderChannelsFromJson('DishTV');
  console.log(`[DishTV] JSON चॅनेल्स: ${dishJsonChannels.length}`);

  const channelsMap = {};
  if (!dishJsonChannels.length) return channelsMap;

  const allowedDishMap = new Map();
  for (const ch of dishJsonChannels) {
    allowedDishMap.set(ch.id, ch);
    const xmlId = `dtv_${ch.id}`;
    channelsMap[xmlId] = {
      id: xmlId,
      name: ch.name || `DishTV ${ch.id}`,
      logo: ch.logo || '',
      programmes: []
    };
  }

  const token = await getDishToken();
  if (!token) {
    console.log('[DishTV] Token मिळाला नाही, DishTV स्किप करत आहे.');
    return channelsMap;
  }

  const today = dayjs().tz(TZ);
  const datesToFetch = [];
  for (let i = -8; i <= 1; i++) {
    datesToFetch.push(today.add(i, 'day').format('DD/MM/YYYY'));
  }

  const totalPages = 107;

  for (const dateStr of datesToFetch) {
    console.log(`[DishTV] Date: ${dateStr}`);
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
          if (!channelsMap[xmlId].name) {
            channelsMap[xmlId].name = jsonEntry.name || ch.channelname || '';
          }
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

  console.log(`[DishTV] पूर्ण झाले. Channels: ${Object.keys(channelsMap).length}`);
  return channelsMap;
}

// ==========================================
// STEP 2: JIOTV (JSON मधून | Past 8d + Today + Future 1d)
// ==========================================
async function fetchJioTVData() {
  console.log('\n=== STEP 2/3: JioTV (Past 8d + Today + Future 1d) ===');
  const jioJsonChannels = loadProviderChannelsFromJson('JioTV');
  console.log(`[JioTV] JSON चॅनेल्स: ${jioJsonChannels.length}`);

  const channelsMap = {};
  if (!jioJsonChannels.length) return channelsMap;

  const offsets = [-8, -7, -6, -5, -4, -3, -2, -1, 0, 1];
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

  console.log(`[JioTV] पूर्ण झाले. Channels: ${Object.keys(channelsMap).length}`);
  return channelsMap;
}

// ==========================================
// STEP 3: TATAPAY (JSON शिवाय थेट API | Past 1d + Today + Future 1d)
// ==========================================
async function fetchTataPlayData() {
  console.log('\n=== STEP 3/3: TataPlay (Past 1d + Today + Future 1d) ===');
  const today = dayjs().tz(TZ);
  const datesToFetch = [
    today.subtract(1, 'day').format('DD-MM-YYYY'),
    today.format('DD-MM-YYYY'),
    today.add(1, 'day').format('DD-MM-YYYY')
  ];

  const channelsMap = {};

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

  console.log(`[TataPlay] पूर्ण झाले. Channels: ${Object.keys(channelsMap).length}`);
  return channelsMap;
}

function appendProgrammesXml(channelsMap, minStartMs, maxEndMs) {
  let chunkXml = '';
  for (const ch of Object.values(channelsMap)) {
    const seen = new Set();
    for (const p of ch.programmes) {
      if (p.stopMs > minStartMs && p.startMs < maxEndMs) {
        const key = `${p.startMs}_${p.stopMs}_${p.title}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const startStr = dayjs(p.startMs).tz(TZ).format('YYYYMMDDHHmmss ZZ');
        const stopStr = dayjs(p.stopMs).tz(TZ).format('YYYYMMDDHHmmss ZZ');

        chunkXml += `  <programme start="${startStr}" stop="${stopStr}" channel="${escapeXML(ch.id)}">\n`;
        chunkXml += `    <title lang="en">${escapeXML(p.title)}</title>\n`;
        if (p.desc) {
          chunkXml += `    <desc lang="en">${escapeXML(p.desc)}</desc>\n`;
        }
        if (p.category) {
          chunkXml += `    <category lang="en">${escapeXML(p.category)}</category>\n`;
        }
        if (p.icon) {
          chunkXml += `    <icon src="${escapeXML(p.icon)}" />\n`;
        }
        chunkXml += `  </programme>\n`;
      }
    }
  }
  return chunkXml;
}

async function main() {
  const now = dayjs().tz(TZ);
  const past8StartMs = now.subtract(8, 'day').startOf('day').valueOf();
  const past1StartMs = now.subtract(1, 'day').startOf('day').valueOf();
  const future1EndMs = now.add(1, 'day').endOf('day').valueOf();

  // १. आधी DishTV (Past 8d + Today + Future 1d)
  const dishMap = await fetchDishTVData();

  // २. नंतर JioTV (Past 8d + Today + Future 1d)
  const jioMap = await fetchJioTVData();

  // ३. नंतर TataPlay (Past 1d + Today + Future 1d)
  const tataMap = await fetchTataPlayData();

  // सर्व चॅनेल्स एकत्र करणे
  const allChannels = [
    ...Object.values(dishMap),
    ...Object.values(jioMap),
    ...Object.values(tataMap)
  ];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Combine-EPG">\n';

  for (const ch of allChannels) {
    xml += `  <channel id="${escapeXML(ch.id)}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  }

  // DishTV + JioTV: Past 8d + Today + Future 1d
  xml += appendProgrammesXml(dishMap, past8StartMs, future1EndMs);
  xml += appendProgrammesXml(jioMap, past8StartMs, future1EndMs);

  // TataPlay: Past 1d + Today + Future 1d
  xml += appendProgrammesXml(tataMap, past1StartMs, future1EndMs);

  xml += '</tv>';

  // epg फोल्डर स्वच्छ करून फक्त combine.xml.gz तयार करणे
  fs.rmSync('./epg', { recursive: true, force: true });
  fs.mkdirSync('./epg', { recursive: true });
  fs.writeFileSync('./epg/combine.xml.gz', zlib.gzipSync(xml));

  console.log('\n✅ फक्त ./epg/combine.xml.gz तयार झाली आहे!');
}

main().catch((err) => {
  console.error('Fatal Error:', err);
});
