"use strict";

const get = id => document.getElementById(id);
const number = new Intl.NumberFormat("ko-KR");
const ordered = (a, b) => a.localeCompare(b, "ko");
const fileState = { stations: {}, prices: {} };
const connectionsByProvince = new Map();
let view = "home";
let mapVersion = 0;
let selectedStation = null;
let shownStations = [];
let shownConnections = new Map();

function make(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

const mapView = new StationMap(get("map"), station => chooseStation(station, false));
get("zoom-in").onclick = () => mapView.changeZoom(1.5);
get("zoom-out").onclick = () => mapView.changeZoom(1 / 1.5);
get("map-reset").onclick = () => mapView.fit();

const provinceInput = get("province");
const districtInput = get("district");
for (const [code, province] of [...provinces].sort((a, b) => ordered(a[1].name, b[1].name))) {
  provinceInput.add(new Option(province.name, code));
}
provinceInput.onchange = () => {
  districtInput.replaceChildren(new Option("시도 전체", ""));
  const districts = provinces.get(provinceInput.value)?.districts;
  districtInput.disabled = !districts || provinceInput.value === "36";
  if (!districtInput.disabled) {
    const areas = [...districts.values()].sort((a, b) => ordered(a.name, b.name));
    for (const area of areas) districtInput.add(new Option(area.name, area.key));
  }
  refresh();
};
districtInput.onchange = refresh;

function route() {
  const fragment = location.hash.slice(1);
  view = fragment === "extract" || fragment === "lookup" ? fragment : "home";
  get("home").hidden = view !== "home";
  get("workspace").hidden = view === "home";
  get("extract-view").hidden = view !== "extract";
  get("lookup-view").hidden = view !== "lookup";
  if (view !== "home") {
    get("screen-title").textContent = view === "extract" ? "지역별 CSV 추출" : "지도에서 주유소·가격 조회";
    get("screen-title").focus();
  }
  refresh();
}
window.addEventListener("hashchange", route);

function afterPaint() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function summarizeFiles() {
  const summary = get("file-status");
  summary.dataset.error = String(Object.values(fileState).some(state => state.error));
  summary.textContent = Object.entries(fileState).map(([type, state]) => {
    const label = type === "stations" ? "주유소" : "가격";
    if (state.loading) return state.name + " 읽는 중…";
    if (state.error) return state.name + " — " + state.error;
    if (!state.data) return "";
    const unknown = state.data.unresolved;
    return `${label} ${number.format(state.data.rows.length)}건` +
      (unknown ? ` (시군구 미확인 ${number.format(unknown)}건)` : "");
  }).filter(Boolean).join(" · ") || "주유소와 판매가격 CSV를 선택하세요.";
}

for (const type of ["stations", "prices"]) {
  get(type).onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    const state = { name: file.name, loading: true };
    fileState[type] = state;
    connectionsByProvince.clear();
    refresh();
    try {
      const bytes = await file.arrayBuffer();
      await afterPaint();
      if (fileState[type] !== state) return;
      state.data = loadCsv(bytes, type);
    } catch (error) {
      state.error = error instanceof TypeError ? "UTF-8 또는 CP949 파일인지 확인하세요." : error.message;
    } finally {
      if (fileState[type] === state) {
        state.loading = false;
        connectionsByProvince.clear();
        refresh();
      }
    }
  };
}

function regionRows(type, province, district) {
  return fileState[type].data?.rows.filter(row => forRegion(row, province, district)) || [];
}

function refresh() {
  summarizeFiles();
  const version = ++mapVersion;
  const province = provinceInput.value, district = districtInput.value;
  const available = Boolean(fileState.stations.data && fileState.prices.data);
  if (view === "extract") {
    get("download-status").textContent = "";
    const ready = Boolean(province && available);
    get("download-stations").disabled = !ready;
    get("download-prices").disabled = !ready;
    if (ready) {
      const stations = regionRows("stations", province, district).length;
      const prices = regionRows("prices", province, district).length;
      get("extract-summary").textContent = `주유소 ${number.format(stations)}건 · 가격 기록 ${number.format(prices)}건`;
    } else {
      get("extract-summary").textContent = available ? "추출할 시도를 선택하세요." : "두 CSV를 모두 올리면 지역 자료를 저장할 수 있습니다.";
    }
  }
  if (view === "lookup") updateMap(version, province, district, available);
}

async function download(type) {
  const province = provinceInput.value, district = districtInput.value;
  const dataset = fileState[type].data;
  if (!province || !dataset || !fileState.stations.data || !fileState.prices.data) return;
  const provinceInfo = provinces.get(province);
  const area = provinceInfo.districts.get(district);
  const label = type === "stations" ? "주유소" : "주유가격";
  const filename = [provinceInfo.name, area?.name, label].filter(Boolean).join("_") + ".csv";
  const encoding = get("encoding").value;
  const status = get("download-status");
  status.dataset.error = "false";
  status.textContent = filename + " 준비 중…";
  const rows = regionRows(type, province, district);
  await afterPaint();
  try {
    const blob = encodeCsv(serializeCsv(dataset, rows), encoding);
    const url = URL.createObjectURL(blob);
    const link = make("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    status.textContent = filename + " 다운로드를 요청했습니다.";
  } catch (error) {
    status.dataset.error = "true";
    status.textContent = error.message;
  }
}
get("download-stations").onclick = () => download("stations");
get("download-prices").onclick = () => download("prices");

async function updateMap(version, province, district, available) {
  const status = get("map-status");
  get("station-search").value = "";
  get("station-search").disabled = true;
  selectedStation = null;
  shownStations = [];
  shownConnections = new Map();
  mapView.clear();
  renderStations();
  renderStationDetail();
  if (!province) {
    status.textContent = "지도에 표시할 시도를 선택하세요.";
    return;
  }

  status.textContent = "지역 경계와 주유소 자료 준비 중…";
  try {
    const shapes = await loadGeometry(province);
    if (version !== mapVersion) return;
    if (available && !connectionsByProvince.has(province)) {
      connectionsByProvince.set(province, matchPrices(
        regionRows("stations", province, ""), regionRows("prices", province, ""),
      ));
    }
    shownConnections = connectionsByProvince.get(province) || new Map();
    shownStations = regionRows("stations", province, district)
      .sort((a, b) => ordered(a.name, b.name) || ordered(a.road || a.lot, b.road || b.lot));
    const region = provinces.get(province).districts.get(district);
    mapView.setRegion(shapes, region?.ids, shownStations, shownConnections);
    get("station-search").disabled = !shownStations.length;
    renderStations();
    const counts = { linked: 0, ambiguous: 0, invalid: 0 };
    for (const station of shownStations) {
      const connection = shownConnections.get(station);
      if (connection?.status === "linked") counts.linked++;
      if (connection?.status === "ambiguous") counts.ambiguous++;
      if (!station.coords) counts.invalid++;
    }
    const metrics = [`주유소 ${number.format(shownStations.length)}곳`];
    if (available) {
      metrics.push(`가격 연결 ${number.format(counts.linked)}곳`,
        `미연결 ${number.format(shownStations.length - counts.linked)}곳`);
      if (counts.ambiguous) metrics.push(`연결 확인 필요 ${number.format(counts.ambiguous)}곳`);
    } else {
      metrics.push("가격을 보려면 두 CSV를 올리세요");
    }
    if (counts.invalid) metrics.push(`좌표 오류로 지도 표시 제외 ${number.format(counts.invalid)}곳`);
    status.textContent = metrics.join(" · ");
  } catch (error) {
    if (version === mapVersion) status.textContent = error.message;
  }
}

function renderStations() {
  const list = get("station-list");
  list.replaceChildren();
  const query = compact(get("station-search").value);
  const fragment = document.createDocumentFragment();
  let count = 0;
  for (const station of shownStations) {
    if (query && !compact(station.name + " " + station.road + " " + station.lot).includes(query)) continue;
    count++;
    const li = make("li");
    const button = make("button", station.name || "상호 미기재");
    button.type = "button";
    button.setAttribute("aria-pressed", String(station === selectedStation));
    button.append(make("small", station.road || station.lot || "주소 미기재"));
    button.onclick = () => chooseStation(station, true);
    li.append(button);
    fragment.append(li);
  }
  if (!count) fragment.append(make("li", query ? "검색 결과가 없습니다." : "표시할 주유소가 없습니다."));
  list.append(fragment);
}
get("station-search").oninput = renderStations;

function chooseStation(station, reveal) {
  const focusedInList = reveal && get("station-list").contains(document.activeElement);
  const list = get("station-list");
  const scroll = list.scrollTop;
  selectedStation = station;
  mapView.select(station, reveal);
  renderStations();
  list.scrollTop = scroll;
  const active = list.querySelector('[aria-pressed="true"]');
  if (focusedInList && active) active.focus({ preventScroll: true });
  if (!reveal && active) {
    const outside = scroll + active.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (outside < scroll || outside + active.offsetHeight > scroll + list.clientHeight) list.scrollTop = outside;
  }
  renderStationDetail();
}

function renderStationDetail() {
  const detail = get("station-detail");
  detail.replaceChildren();
  if (!selectedStation) {
    detail.append(make("p", "지도나 목록에서 주유소를 선택하세요."));
    return;
  }
  detail.append(make("h2", selectedStation.name || "상호 미기재"),
    make("p", selectedStation.road || selectedStation.lot || "주소 미기재"),
    make("p", selectedStation.brand || "상표 미기재"));
  const match = shownConnections.get(selectedStation);
  if (match?.status !== "linked") {
    detail.append(make("p", match?.status === "ambiguous" ? "가격 연결 확인 필요" :
      fileState.prices.data ? "연결된 가격 없음" : "판매가격 CSV를 올리세요."));
    return;
  }

  const dateLabel = make("label", "기록 날짜");
  const dates = make("select");
  const records = new Map();
  for (const record of match.rows) {
    if (!records.has(record.date)) records.set(record.date, []);
    records.get(record.date).push(record);
  }
  for (const date of records.keys()) {
    dates.add(new Option(date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") || "날짜 미기재", date));
  }
  dateLabel.append(dates);
  const values = make("dl");
  const note = make("p");
  function renderPrices() {
    const rows = records.get(dates.value);
    values.replaceChildren();
    note.textContent = "";
    if (rows.length > 1 && rows.some(row => row.fuels.some((fuel, i) => fuel !== rows[0].fuels[i]))) {
      note.textContent = "이 날짜에 서로 다른 가격 기록이 있습니다.";
      return;
    }
    FUELS.forEach((fuel, index) => {
      const raw = rows[0].fuels[index];
      const price = !raw ? "기록 없음" : Number(raw) === 0 ? "가격 미확인" :
        /^\d+(?:\.\d+)?$/.test(raw) ? number.format(Number(raw)) + "원/L" : raw;
      const item = make("div");
      item.append(make("dt", fuel), make("dd", price));
      values.append(item);
    });
  }
  dates.onchange = renderPrices;
  detail.append(dateLabel, values, note);
  renderPrices();
}

route();
