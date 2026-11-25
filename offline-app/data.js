"use strict";

const STATION_FIELDS = "주유소명 시도명 시군구명 소재지도로명주소 소재지지번주소 전화번호 위도 경도 상표구분명 대표자명 총직원수 데이터기준일자 제공기관코드 제공기관명".split(" ");
const PRICE_FIELDS = "번호 지역 상호 주소 기간 상표 셀프여부 고급휘발유 휘발유 경유 실내등유".split(" ");
const FUELS = PRICE_FIELDS.slice(7);

const PROVINCE_ALIASES = {
  "11": ["서울", "서울시"], "12": ["전남광주", "전남", "전라남도", "광주", "광주시", "광주광역시"],
  "26": ["부산", "부산시"], "27": ["대구", "대구시"], "28": ["인천", "인천시"],
  "30": ["대전", "대전시"], "31": ["울산", "울산시"], "36": ["세종", "세종시"],
  "41": ["경기"], "43": ["충북"], "44": ["충남"], "47": ["경북"], "48": ["경남"],
  "50": ["제주", "제주도"], "51": ["강원", "강원도"], "52": ["전북", "전라북도"],
};

function compact(text) {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

const provinces = new Map(Object.entries(window.REGION_INDEX).map(([code, province]) => {
  const districts = new Map();
  for (const [id, name] of Object.entries(province.districts)) {
    const key = compact(name);
    const city = key.match(/^(.+?시)(.+구)$/);
    districts.set(key, { key, name: city ? city[1] + " " + city[2] : name, ids: [id], parent: city?.[1] });
    if (city) {
      if (!districts.has(city[1])) districts.set(city[1], { key: city[1], name: city[1], ids: [] });
      districts.get(city[1]).ids.push(id);
    }
  }
  return [code, {
    name: province.name,
    districts,
    aliases: [province.name, ...(PROVINCE_ALIASES[code] || [])].map(compact),
  }];
}));
const provincePrefixes = [...provinces].flatMap(([code, province]) =>
  province.aliases.map(alias => [alias, code])).sort(([a], [b]) => b.length - a.length);

function readRegion(provinceText, districtText, address) {
  const region = compact(provinceText);
  const prefix = provincePrefixes.find(([name]) => region.startsWith(name));
  if (!prefix) return {};
  const [name, province] = prefix;
  const districts = provinces.get(province).districts;
  const stated = compact(districtText || region.slice(name.length));
  const area = districts.get(stated);
  if (province === "36" && ["", "없음", "세종특별자치시"].includes(stated)) {
    return { province, area: "세종시", locality: "세종시" };
  }
  if (!area) return { province };

  let key = area.key;
  if (area.ids.length > 1) {
    let addressStart = compact(address);
    const addressPrefix = provinces.get(province).aliases
      .filter(alias => addressStart.startsWith(alias)).sort((a, b) => b.length - a.length)[0];
    if (addressPrefix) addressStart = addressStart.slice(addressPrefix.length);
    for (const child of districts.values()) {
      if (child.parent === key && (addressStart.startsWith(child.key) ||
          addressStart.startsWith(child.key.slice(key.length)))) {
        key = child.key;
        break;
      }
    }
  }
  return { province, area: key, locality: area.parent || area.key };
}

function parseCsv(text) {
  const records = [];
  let row = [], field = "", quoted = false, closed = false;
  function endField() {
    row.push(field);
    field = "";
    closed = false;
  }
  function endRow() {
    endField();
    if (row.length > 1 || row[0].trim()) records.push(row);
    row = [];
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else {
        field += char;
      }
    } else if (char === ",") {
      endField();
    } else if (char === "\r" || char === "\n") {
      endRow();
      if (char === "\r" && text[index + 1] === "\n") index++;
    } else if (char === '"' && !field && !closed) {
      quoted = true;
    } else {
      if (closed || char === '"') throw new Error(`CSV 레코드 ${records.length + 1}의 인용부호를 확인하세요.`);
      field += char;
    }
  }
  if (quoted) throw new Error("닫히지 않은 인용부호가 있습니다.");
  if (row.length || field || closed) endRow();
  return records;
}

function decodeCsv(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("euc-kr", { fatal: true }).decode(buffer);
  }
}

function loadCsv(buffer, type) {
  const records = parseCsv(decodeCsv(buffer));
  const header = records.shift();
  const fields = type === "stations" ? STATION_FIELDS : PRICE_FIELDS;
  if (!header) throw new Error("CSV 헤더가 없습니다.");
  const index = new Map(header.map((field, offset) => [field.trim(), offset]));
  const missing = fields.filter(field => !index.has(field));
  if (missing.length) throw new Error("필수 헤더가 없습니다. " + missing.join(", "));
  if (index.size !== header.length) throw new Error("헤더에 같은 열 이름이 두 번 이상 있습니다.");
  const note = type === "prices" && records[0]?.length === 1 && /^기준\s*:/.test(records[0][0].trim())
    ? records.shift() : null;
  const rows = records.map((values, offset) => {
    if (values.length !== header.length) {
      throw new Error(`CSV 레코드 ${offset + (note ? 3 : 2)}의 열 수가 ${values.length}개입니다. 헤더는 ${header.length}열입니다.`);
    }
    const get = field => values[index.get(field)].trim();
    if (type === "stations") {
      const road = get("소재지도로명주소");
      const lot = get("소재지지번주소");
      const lat = get("위도"), lon = get("경도");
      const coords = lat && lon && Number(lat) >= 33 && Number(lat) <= 39 &&
        Number(lon) >= 124 && Number(lon) <= 132 ? [Number(lon), Number(lat)] : null;
      return {
        values, road, lot, coords, name: get("주유소명"), brand: get("상표구분명"),
        ...readRegion(get("시도명"), get("시군구명"), road || lot),
      };
    }
    const address = get("주소");
    return {
      values, address, id: get("번호"), name: get("상호"), date: get("기간"),
      fuels: FUELS.map(get),
      ...readRegion(get("지역"), "", address),
    };
  });
  return { header, note, rows, unresolved: rows.filter(row => !row.area).length };
}

function forRegion(row, province, district) {
  return row.province === province && (!district || row.area === district || row.locality === district);
}

function addressKeys(address) {
  const clean = address.normalize("NFKC").replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const text = compact(clean);
  const province = provincePrefixes.find(([alias]) => text.startsWith(alias));
  const keys = ["full:" + (province ? text.slice(province[0].length) : text)];
  const road = clean.match(/(?:^|\s)([\p{L}\d·.]+?(?:대로|로|길))\s*(\d+(?:\s*-\s*\d+)?)(?![\d-])/u);
  const lot = clean.match(/(?:^|\s)([가-힣\d]+[동리])\s*(산\s*)?(\d+(?:\s*-\s*\d+)?)(?![\d-])/u);
  if (road) keys.push("road:" + compact(road[1] + road[2]));
  if (lot) keys.push("lot:" + compact(lot[1] + (lot[2] || "") + lot[3]));
  return keys;
}

function matchPrices(stations, prices) {
  const history = new Map();
  const index = new Map();
  const indexedAddresses = new Set();
  const keyFor = (row, addressKey) => JSON.stringify([row.locality, compact(row.name), addressKey]);
  for (const row of prices) {
    if (!row.id) continue;
    if (!history.has(row.id)) history.set(row.id, []);
    history.get(row.id).push(row);
    if (!row.locality || !row.name) continue;
    const recordKey = JSON.stringify([row.id, row.locality, row.area, row.name, row.address]);
    if (indexedAddresses.has(recordKey)) continue;
    indexedAddresses.add(recordKey);
    for (const addressKey of addressKeys(row.address)) {
      const key = keyFor(row, addressKey);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
  }

  const candidates = new Map();
  const uses = new Map();
  for (const station of stations) {
    const ids = new Set();
    candidates.set(station, ids);
    if (!station.locality || !station.name) continue;
    for (const key of new Set([...addressKeys(station.road), ...addressKeys(station.lot)])) {
      for (const candidate of index.get(keyFor(station, key)) || []) {
        if (candidate.area === station.area ||
            candidate.area === candidate.locality || station.area === station.locality) {
          ids.add(candidate.id);
        }
      }
    }
    for (const id of ids) uses.set(id, (uses.get(id) || 0) + 1);
  }

  const matches = new Map();
  for (const [station, ids] of candidates) {
    const [id] = ids;
    if (ids.size === 1 && uses.get(id) === 1) {
      matches.set(station, { status: "linked", rows: history.get(id).sort((a, b) => b.date.localeCompare(a.date)) });
    } else {
      matches.set(station, { status: ids.size ? "ambiguous" : "missing" });
    }
  }
  return matches;
}

function serializeCsv(dataset, rows) {
  const escape = value => /[,"\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  const records = [dataset.header, ...(dataset.note ? [dataset.note] : []), ...rows.map(row => row.values)];
  return records.map(record => record.map(escape).join(",")).join("\r\n") + "\r\n";
}

let cp949Codes;
function encodeCsv(text, encoding) {
  if (encoding !== "cp949") return new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" });
  if (!cp949Codes) {
    // The browser's EUC-KR decoder includes the Windows CP949 character set.
    cp949Codes = new Map();
    const decoder = new TextDecoder("euc-kr", { fatal: true });
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x41; trail <= 0xfe; trail++) {
        try {
          const char = decoder.decode(Uint8Array.of(lead, trail));
          if ([...char].length === 1 && !cp949Codes.has(char)) cp949Codes.set(char, [lead, trail]);
        } catch {
          // Undefined byte pairs have no encoding.
        }
      }
    }
  }
  const bytes = new Uint8Array(text.length * 2);
  let size = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) {
      bytes[size++] = char.charCodeAt(0);
    } else {
      const code = cp949Codes.get(char);
      if (!code) throw new Error("CP949로 저장할 수 없는 문자가 있습니다. UTF-8 BOM을 선택하세요.");
      bytes.set(code, size);
      size += 2;
    }
  }
  return new Blob([bytes.subarray(0, size)], { type: "text/csv;charset=euc-kr" });
}
