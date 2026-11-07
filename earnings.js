/* 실적 발표 PDF 분석: 빅테크 보도자료에서 설비투자·현금흐름·클라우드 실적을 읽어 보여줍니다.
   PDF는 이 브라우저 안에서만 읽고 어디에도 보내지 않습니다. */
(function () {
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const KEY = "signal-board-earnings-v1";

  const COMPANIES = [
    { id: "googl", name: "알파벳", match: /\bAlphabet\b/, cloud: /^google cloud\b/i, cloudName: "구글 클라우드" },
    { id: "msft", name: "마이크로소프트", match: /\bMicrosoft\b/, cloud: /^(microsoft cloud|intelligent cloud)\b/i, cloudName: "클라우드" },
    { id: "amzn", name: "아마존", match: /\bAmazon(\.com)?\b/, cloud: /^aws\b/i, cloudName: "AWS" },
    { id: "meta", name: "메타", match: /\bMeta Platforms\b|\bMeta\b/, cloud: null, cloudName: "" }
  ];
  const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

  let reports = {};
  try { reports = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { reports = {}; }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(reports)); } catch (e) {} };
  let status = "";

  /* ── PDF → 줄 단위 텍스트 ── */
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = PDFJS;
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; resolve(window.pdfjsLib); };
      s.onerror = () => reject(new Error("PDF 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인하세요."));
      document.head.appendChild(s);
    });
  }
  async function pdfLines(file) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      const rows = [];
      tc.items.forEach(it => {
        if (!it.str || !it.str.trim()) return;
        const y = it.transform[5], x = it.transform[4];
        let r = rows.find(r => Math.abs(r.y - y) < 2.5);
        if (!r) rows.push(r = { y, items: [] });
        r.items.push({ x, s: it.str });
      });
      rows.sort((a, b) => b.y - a.y);
      rows.forEach(r => out.push(r.items.sort((a, b) => a.x - b.x).map(i => i.s).join(" ").replace(/\s+/g, " ").trim()));
    }
    return out;
  }

  /* ── 줄에서 숫자 읽기 ── */
  const NUM_RE = /\(\s*\$?\s*[\d,]+(?:\.\d+)?\s*\)|-?\$?\s*[\d,]*\d(?:\.\d+)?|—/g;
  function numbersAfter(line, labelEnd) {
    const rest = line.slice(labelEnd);
    if (/%/.test(rest)) return [];
    const out = [];
    (rest.match(NUM_RE) || []).forEach(t => {
      if (t === "—") { out.push(0); return; }
      const neg = t.includes("(") || /^-/.test(t.trim());
      const v = parseFloat(t.replace(/[()$,\s-]/g, ""));
      if (!isNaN(v)) out.push(neg ? -v : v);
    });
    return out;
  }
  function findRow(lines, re, { from = 0, min = 2 } = {}) {
    for (let i = from; i < lines.length; i++) {
      const l = lines[i].replace(/^less:\s*/i, "");
      const m = l.match(re);
      if (!m || m.index !== 0) continue;
      const nums = numbersAfter(l, m[0].length).filter(n => !(Number.isInteger(n) && n >= 1990 && n <= 2100 && !l.includes(",")));
      if (nums.length >= min) return { i, nums };
    }
    return null;
  }
  function yearOrderAbove(lines, i) {
    for (let k = i; k >= Math.max(0, i - 25); k--) {
      const ys = lines[k].match(/\b20\d\d\b/g);
      if (ys && ys.length >= 2 && /^[\s\d]+$/.test(lines[k].replace(/20\d\d/g, ""))) return Number(ys[0]) < Number(ys[1]) ? "asc" : "desc";
    }
    return "asc";
  }
  function pair(lines, row, offset = 0) {
    if (!row || row.nums.length < offset + 2) return null;
    const a = Math.abs(row.nums[offset]), b = Math.abs(row.nums[offset + 1]);
    return yearOrderAbove(lines, row.i) === "asc" ? { prev: a, cur: b } : { prev: b, cur: a };
  }
  const isoFrom = s => {
    const m = s && s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(20\d\d)/);
    if (!m || !MONTHS[m[1].toLowerCase()]) return null;
    return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  };

  /* ── 보도자료 분석 ── */
  function analyze(lines, fileName) {
    const text = lines.join(" ");
    const head = lines.slice(0, 12).join(" ");
    const co = COMPANIES.find(c => c.match.test(head)) || COMPANIES.find(c => c.match.test(text));
    const scale = /in billions/i.test(text) ? 1 : 1 / 1000;  // 기본은 백만 달러 단위
    const periodEnd = isoFrom((text.match(/(?:quarter|three months) ended\s+([A-Za-z]+ \d{1,2},\s*20\d\d)/i) || [])[1]);
    const releaseDate = isoFrom((head.match(/[A-Za-z]+ \d{1,2},\s*20\d\d/) || [])[0]);

    const cfStart = Math.max(0, lines.findIndex(l => /cash flows/i.test(l)));
    const capexRe = /(purchases of property and equipment(, net)?|additions to property and equipment|capital expenditures)/i;
    const capexRow = findRow(lines, capexRe, { from: cfStart }) || findRow(lines, capexRe);
    const ocfRe = /net cash (provided by|from)( \(used in\))? operat(ing activities|ions)/i;
    const ocfRow = findRow(lines, ocfRe, { from: cfStart }) || findRow(lines, ocfRe);
    const revRow = findRow(lines, /(total )?(revenues?|net sales)\b/i);

    const capex = pair(lines, capexRow);
    const ytd = capexRow && capexRow.nums.length >= 4 ? pair(lines, capexRow, 2) : null;
    const ocf = pair(lines, ocfRow);
    const rev = pair(lines, revRow);

    let cloud = null;
    if (co && co.cloud) {
      const r1 = findRow(lines, co.cloud);
      const cr = pair(lines, r1);
      if (cr) {
        cloud = { rev: cr };
        const opIdx = lines.findIndex((l, k) => k > r1.i && /^operating income/i.test(l));
        if (opIdx > 0) cloud.op = pair(lines, findRow(lines, co.cloud, { from: opIdx }));
      }
    }

    const debt = pair(lines, findRow(lines, /proceeds from (the )?(issuance of )?(long-term )?(debt|notes)/i, { from: cfStart }));
    const buyback = pair(lines, findRow(lines, /(repurchases of (class a )?(common )?stock|common stock repurchased)/i, { from: cfStart }));

    // 최근 분기 추이 (예: 잉여현금흐름 표의 Q4 2025 … Q3 2026)
    let trend = null;
    for (let i = 0; i < lines.length && !trend; i++) {
      const qs = lines[i].match(/Q[1-4]\s*20\d\d/g);
      if (!qs || qs.length < 3) continue;
      for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) {
        const l = lines[k].replace(/^less:\s*/i, "");
        const m = l.match(capexRe);
        if (m && m.index === 0) {
          const n = numbersAfter(l, m[0].length);
          if (n.length >= qs.length - 1) {
            const labels = /TTM|trailing/i.test(lines[i - 1] + lines[i]) ? qs.slice(0, -1) : qs;
            trend = labels.map((q, j) => ({ label: q.replace(/\s+/, " "), value: Math.abs(n[j]) * scale }));
          }
          break;
        }
      }
    }

    const guidance = text.split(/(?<=[.!?])\s+/)
      .filter(s => /capital expenditure|capex/i.test(s) && /(expect|anticipat|outlook|guidance|range|plan|will)/i.test(s) && s.length < 500)
      .slice(0, 4);

    const sc = o => o ? { prev: o.prev * scale, cur: o.cur * scale } : null;
    return {
      co: co ? co.id : "other", name: co ? co.name : (lines[0] || "알 수 없는 회사").slice(0, 40),
      cloudName: co ? co.cloudName : "",
      fileName, periodEnd, releaseDate, analyzedAt: new Date().toISOString().slice(0, 10),
      capex: sc(capex), ytd: sc(ytd), ocf: sc(ocf), rev: sc(rev),
      cloud: cloud ? { rev: sc(cloud.rev), op: sc(cloud.op) } : null,
      debt: sc(debt), buyback: sc(buyback), trend, guidance
    };
  }

  /* ── 화면 ── */
  const B = v => v == null ? "–" : "$" + v.toFixed(1) + "B";
  const pct = (a, b) => (a == null || !b) ? null : (a / b - 1) * 100;
  const P = v => v == null ? "" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${v.toFixed(0)}%</span>`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function periodLabel(iso) {
    if (!iso) return "기간 미확인";
    const [y, m] = iso.split("-").map(Number);
    return `${y}년 ${Math.ceil(m / 3)}분기 (${m}월 ${Number(iso.slice(8))}일 마감)`;
  }

  function readings(r) {
    const out = [];
    const yoy = r.capex && pct(r.capex.cur, r.capex.prev);
    const t = r.trend;
    const qoq = t && t.length >= 2 ? pct(t[t.length - 1].value, t[t.length - 2].value) : null;
    if (yoy != null) {
      if (yoy >= 0 && (qoq == null || qoq >= 0)) out.push(`설비투자가 전년 같은 분기보다 ${yoy.toFixed(0)}% 늘었고${qoq != null ? `, 직전 분기보다도 ${qoq.toFixed(0)}% 늘었습니다` : ""}. 이번 분기 숫자로는 AI 투자를 줄이는 신호가 보이지 않습니다.`);
      else if (yoy >= 0) out.push(`설비투자가 전년보다는 ${yoy.toFixed(0)}% 늘었지만 직전 분기보다는 ${Math.abs(qoq).toFixed(0)}% 줄었습니다. 일시적인지 다음 분기와 함께 확인하세요.`);
      else out.push(`설비투자가 전년 같은 분기보다 ${Math.abs(yoy).toFixed(0)}% 줄었습니다. 회계 변경 때문인지, 실제 투자 축소인지 컨퍼런스콜 설명을 확인하세요.`);
    }
    if (r.capex && r.ocf) {
      if (r.capex.cur > r.ocf.cur) out.push(`설비투자가 영업현금흐름(${B(r.ocf.cur)})보다 커서 잉여현금흐름이 ${B(r.ocf.cur - r.capex.cur).replace("$-", "−$")}입니다. 번 돈보다 많이 투자하고 있다는 뜻이라, 이 속도를 얼마나 유지할 수 있는지가 관건입니다.`);
      else out.push(`영업현금흐름 ${B(r.ocf.cur)} 안에서 투자하고 있어 잉여현금흐름이 ${B(r.ocf.cur - r.capex.cur)} 남았습니다.`);
    }
    if (r.debt && r.debt.cur > 0) {
      let s = `이번 분기 부채로 ${B(r.debt.cur)}를 조달했습니다`;
      if (r.buyback) s += r.buyback.cur === 0 && r.buyback.prev > 0 ? `. 자사주 매입은 전년 ${B(r.buyback.prev)}에서 0으로 멈췄습니다` : `. 자사주 매입은 ${B(r.buyback.cur)}입니다`;
      out.push(s + ".");
    }
    if (r.cloud && r.cloud.rev) {
      const g = pct(r.cloud.rev.cur, r.cloud.rev.prev);
      out.push(`${r.cloudName} 매출이 ${B(r.cloud.rev.cur)}로 전년보다 ${g.toFixed(0)}% 늘어${r.cloud.op ? ` 영업이익 ${B(r.cloud.op.cur)}(전년 ${B(r.cloud.op.prev)})를 냈습니다` : " 투자가 매출로 이어지고 있습니다"}.`);
    }
    return out;
  }

  function cardHTML(r) {
    const yoy = r.capex && pct(r.capex.cur, r.capex.prev);
    const rows = [];
    rows.push(["이번 분기 설비투자", r.capex ? `${B(r.capex.cur)} <small>전년 ${B(r.capex.prev)}</small> ${P(yoy)}` : "찾지 못함"]);
    if (r.ytd) rows.push(["올해 누적 설비투자", `${B(r.ytd.cur)} <small>전년 ${B(r.ytd.prev)}</small> ${P(pct(r.ytd.cur, r.ytd.prev))}`]);
    if (r.trend) rows.push(["최근 분기 추이", r.trend.map(t => `${esc(t.label)} ${t.value.toFixed(1)}`).join(" → ")]);
    if (r.capex && r.ocf) rows.push(["영업현금흐름 대비", `${(r.capex.cur / r.ocf.cur * 100).toFixed(0)}% <small>영업현금흐름 ${B(r.ocf.cur)}</small>`]);
    if (r.capex && r.rev) rows.push(["매출 대비", `${(r.capex.cur / r.rev.cur * 100).toFixed(0)}% <small>매출 ${B(r.rev.cur)} ${P(pct(r.rev.cur, r.rev.prev))}</small>`]);
    if (r.cloud && r.cloud.rev) rows.push([`${esc(r.cloudName)} 매출`, `${B(r.cloud.rev.cur)} ${P(pct(r.cloud.rev.cur, r.cloud.rev.prev))}${r.cloud.op ? ` <small>영업이익 ${B(r.cloud.op.cur)}</small>` : ""}`]);

    const guide = r.guidance && r.guidance.length
      ? `<div class="e-guide"><p>보도자료의 설비투자 계획 문장 (원문):</p><ul>${r.guidance.map(s => `<li>${esc(s)}</li>`).join("")}</ul><p class="sub">이 문장을 보고 위 ‘다음 해 계획’ 칸을 직접 고르세요.</p></div>`
      : `<p class="e-none">이 보도자료에는 다음 해 설비투자 계획이 없습니다. 계획은 보통 컨퍼런스콜에서 밝히니, 그 내용으로 위 ‘다음 해 계획’ 칸을 채우세요.</p>`;

    const canApply = r.co !== "other" && r.capex;
    return `<article class="e-card">
      <header><h5>${esc(r.name)} <span>${periodLabel(r.periodEnd)}${r.releaseDate ? ` · ${r.releaseDate} 발표` : ""}</span></h5>
        <button type="button" class="link" data-e-del="${r.co}|${r.periodEnd}">삭제</button></header>
      <dl class="e-grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      <ul class="e-read">${readings(r).map(s => `<li>${s}</li>`).join("")}</ul>
      ${guide}
      ${canApply ? `<button type="button" class="e-apply" data-e-apply="${r.co}|${r.periodEnd}">확인한 날과 메모를 위 칸에 반영</button>` : ""}
    </article>`;
  }

  window.earningsHTML = function () {
    const latest = Object.values(reports).map(list => list[list.length - 1]).filter(Boolean)
      .sort((a, b) => String(b.periodEnd).localeCompare(String(a.periodEnd)));
    return `<label class="e-drop" data-e-drop>
        <input type="file" accept="application/pdf" multiple data-e-file>
        <span><strong>실적 보도자료 PDF 고르기</strong> 또는 여기에 끌어다 놓기</span>
        <span class="sub">마이크로소프트·알파벳·아마존·메타의 분기 실적 보도자료(Earnings Release). 파일은 이 브라우저 안에서만 읽습니다.</span>
      </label>
      <p class="e-status" aria-live="polite">${esc(status)}</p>
      ${latest.length ? latest.map(cardHTML).join("") : ""}`;
  };

  function rerender() {
    const box = document.querySelector("[data-e-box]");
    if (box) box.innerHTML = window.earningsHTML();
  }
  async function handleFiles(files) {
    for (const f of files) {
      if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { status = `${f.name}: PDF 파일이 아닙니다.`; rerender(); continue; }
      status = `${f.name} 읽는 중…`; rerender();
      try {
        const r = analyze(await pdfLines(f), f.name);
        if (!r.capex) { status = `${f.name}: 설비투자 항목을 찾지 못했습니다. 현금흐름표가 들어 있는 실적 보도자료인지 확인하세요.`; rerender(); continue; }
        const list = (reports[r.co] || []).filter(x => x.periodEnd !== r.periodEnd);
        list.push(r); list.sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));
        reports[r.co] = list.slice(-8); persist();
        status = `${r.name} ${periodLabel(r.periodEnd)} 분석을 마쳤습니다.`;
      } catch (e) {
        status = `${f.name}: 읽지 못했습니다. ${e.message || ""}`;
      }
      rerender();
    }
  }

  document.addEventListener("change", e => {
    if (e.target.matches && e.target.matches("[data-e-file]")) { handleFiles([...e.target.files]); e.target.value = ""; }
  });
  document.addEventListener("dragover", e => { const d = e.target.closest && e.target.closest("[data-e-drop]"); if (d) { e.preventDefault(); d.classList.add("over"); } });
  document.addEventListener("dragleave", e => { const d = e.target.closest && e.target.closest("[data-e-drop]"); if (d) d.classList.remove("over"); });
  document.addEventListener("drop", e => {
    const d = e.target.closest && e.target.closest("[data-e-drop]");
    if (!d) return;
    e.preventDefault(); d.classList.remove("over");
    handleFiles([...e.dataTransfer.files]);
  });
  document.addEventListener("click", e => {
    const del = e.target.closest && e.target.closest("[data-e-del]");
    if (del) {
      const [co, pe] = del.dataset.eDel.split("|");
      reports[co] = (reports[co] || []).filter(x => String(x.periodEnd) !== pe);
      if (!reports[co].length) delete reports[co];
      persist(); status = ""; rerender(); return;
    }
    const ap = e.target.closest && e.target.closest("[data-e-apply]");
    if (ap && typeof state !== "undefined") {
      const [co, pe] = ap.dataset.eApply.split("|");
      const r = (reports[co] || []).find(x => String(x.periodEnd) === pe);
      if (!r) return;
      const yoy = pct(r.capex.cur, r.capex.prev);
      const [y, m] = (r.periodEnd || "").split("-").map(Number);
      const q = y ? `${String(y).slice(2)}년 ${Math.ceil(m / 3)}분기 ` : "";
      state["ai_d_" + co] = r.releaseDate || r.analyzedAt;
      state["ai_m_" + co] = `${q}설비투자 ${B(r.capex.cur)}(${yoy >= 0 ? "+" : ""}${yoy.toFixed(0)}%)` +
        (r.cloud && r.cloud.rev ? `, ${r.cloudName} ${pct(r.cloud.rev.cur, r.cloud.rev.prev) >= 0 ? "+" : ""}${pct(r.cloud.rev.cur, r.cloud.rev.prev).toFixed(0)}%` : "") +
        (r.guidance && r.guidance.length ? "" : ", 보도자료에 내년 계획 없음");
      save(); renderStatic(); update();
      status = `${r.name}의 확인한 날과 메모를 반영했습니다. ‘다음 해 계획’은 직접 골라 주세요.`;
      rerender();
      const row = document.querySelector(`[data-grow="${co}"]`);
      if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });

  window.__earningsAnalyze = analyze; // 테스트용
})();
